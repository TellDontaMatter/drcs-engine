/**
 * C6 (Message-Idea Governance) — Section 19 acceptance tests + supporting cases.
 *
 * Covers:
 *  - "All four C6 dispositions reachable" — distinct valid inputs produce all four
 *  - "No silent downgrade" — no code path substitutes a lower-intensity disposition
 *    on a non-PUBLISH outcome (Section 7 binding constraint)
 *  - allowed_to_acknowledge / must_not_presume persisted as descriptive text, never null
 *  - record written for every trigger; historically queryable per tenant
 *  - tenant isolation of governance records
 */
import * as c6 from '../src/gates/c6';
import {
  ConfidenceTag,
  Disposition,
  ReviewerDirective,
  SituationalTrigger,
  Stakes,
  isProtectedDisposition,
} from '../src/types';
import * as governanceRecord from '../src/persistence/repositories/governanceRecord';

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';

describe('C6 — Message-Idea Governance', () => {
  describe('Acceptance: "All four C6 dispositions reachable"', () => {
    it('PUBLISH — confident, appropriate, belongs here', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Sunny Friday, upbeat momentum',
        confidence_tag: ConfidenceTag.HIGH,
        belongs_here: true,
        appropriate: true,
      };
      const { disposition, record } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.PUBLISH);
      expect(record.disposition).toBe(Disposition.PUBLISH);
    });

    it('REJECT_AND_RECORD — inappropriate to act', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Community tragedy in the news',
        appropriate: false,
      };
      const { disposition } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.REJECT_AND_RECORD);
    });

    it('REJECT_AND_RECORD — explicit reviewer reject directive', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Anything',
        reviewer_directive: ReviewerDirective.REJECT,
      };
      const { disposition } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.REJECT_AND_RECORD);
    });

    it('REROUTE_FOR_RECLASSIFICATION — read does not belong here', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Weather shift misread as a victory moment',
        confidence_tag: ConfidenceTag.MEDIUM,
        belongs_here: false,
        appropriate: true,
      };
      const { disposition } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.REROUTE_FOR_RECLASSIFICATION);
    });

    it('HOLD_FOR_HUMAN_REVIEW — ambiguous situational read', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Unclear whether the moment is celebratory or somber',
        confidence_tag: ConfidenceTag.AMBIGUOUS,
      };
      const { disposition } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.HOLD_FOR_HUMAN_REVIEW);
    });

    it('HOLD_FOR_HUMAN_REVIEW — high stakes with low confidence', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Possibly sensitive anniversary',
        confidence_tag: ConfidenceTag.LOW,
        stakes: Stakes.HIGH,
      };
      const { disposition } = await c6.govern(trigger, TENANT_A);
      expect(disposition).toBe(Disposition.HOLD_FOR_HUMAN_REVIEW);
    });

    it('all four dispositions are produced by distinct valid inputs', async () => {
      const inputs: SituationalTrigger[] = [
        { condition: 'ok', confidence_tag: ConfidenceTag.HIGH },
        { condition: 'no', appropriate: false },
        { condition: 'wrong bank', belongs_here: false },
        { condition: 'unsure', confidence_tag: ConfidenceTag.AMBIGUOUS },
      ];
      const results = inputs.map((t) => c6.decideDisposition(t));
      expect(new Set(results).size).toBe(4);
      expect(new Set(results)).toEqual(
        new Set([
          Disposition.PUBLISH,
          Disposition.REJECT_AND_RECORD,
          Disposition.REROUTE_FOR_RECLASSIFICATION,
          Disposition.HOLD_FOR_HUMAN_REVIEW,
        ]),
      );
    });
  });

  describe('Acceptance: "No silent downgrade"', () => {
    it('a REJECT is not downgraded even when the read otherwise belongs & is confident', () => {
      // Cadence-favorable signals (belongs_here, high confidence) must NOT rescue
      // an inappropriate trigger into PUBLISH/REROUTE.
      const trigger: SituationalTrigger = {
        condition: 'inappropriate but well-classified',
        appropriate: false,
        belongs_here: true,
        confidence_tag: ConfidenceTag.HIGH,
      };
      const disposition = c6.decideDisposition(trigger);
      expect(disposition).toBe(Disposition.REJECT_AND_RECORD);
      expect(isProtectedDisposition(disposition)).toBe(true);
      expect(disposition).not.toBe(Disposition.PUBLISH);
      expect(disposition).not.toBe(Disposition.REROUTE_FOR_RECLASSIFICATION);
    });

    it('a HOLD is not downgraded even when the read otherwise belongs', () => {
      const trigger: SituationalTrigger = {
        condition: 'ambiguous but well-classified',
        confidence_tag: ConfidenceTag.AMBIGUOUS,
        belongs_here: true,
      };
      const disposition = c6.decideDisposition(trigger);
      expect(disposition).toBe(Disposition.HOLD_FOR_HUMAN_REVIEW);
      expect(disposition).not.toBe(Disposition.PUBLISH);
      expect(disposition).not.toBe(Disposition.REROUTE_FOR_RECLASSIFICATION);
    });

    it('an explicit reject wins over a simultaneously-ambiguous read (stays protected)', () => {
      const trigger: SituationalTrigger = {
        condition: 'both flagged',
        reviewer_directive: ReviewerDirective.REJECT,
        confidence_tag: ConfidenceTag.AMBIGUOUS,
      };
      const disposition = c6.decideDisposition(trigger);
      expect(disposition).toBe(Disposition.REJECT_AND_RECORD);
      expect(isProtectedDisposition(disposition)).toBe(true);
    });
  });

  describe('Descriptive fields (Section 6): text, never null', () => {
    it('populates actual descriptive content when phrases are provided', async () => {
      const trigger: SituationalTrigger = {
        condition: 'Late evening, deadline is close',
        confidence_tag: ConfidenceTag.HIGH,
        allowed_to_acknowledge: ["it's late", 'the deadline is close'],
        must_not_presume: ['that the student is panicking'],
      };
      const { record } = await c6.govern(trigger, TENANT_A);
      expect(record.allowed_to_acknowledge).toBe("it's late; the deadline is close");
      expect(record.must_not_presume).toBe('that the student is panicking');
    });

    it('falls back to descriptive text (not null) when no phrases are provided', async () => {
      const trigger: SituationalTrigger = { condition: 'Generic upbeat moment' };
      const { record } = await c6.govern(trigger, TENANT_A);
      expect(record.allowed_to_acknowledge).not.toBeNull();
      expect(record.must_not_presume).not.toBeNull();
      expect((record.allowed_to_acknowledge ?? '').length).toBeGreaterThan(0);
      expect((record.must_not_presume ?? '').length).toBeGreaterThan(0);
    });
  });

  describe('Record production & historical queryability', () => {
    it('writes a record for every trigger regardless of disposition', async () => {
      await c6.govern({ condition: 'a', confidence_tag: ConfidenceTag.HIGH }, TENANT_A);
      await c6.govern({ condition: 'b', appropriate: false }, TENANT_A);
      await c6.govern({ condition: 'c', belongs_here: false }, TENANT_A);
      await c6.govern({ condition: 'd', confidence_tag: ConfidenceTag.AMBIGUOUS }, TENANT_A);

      const all = await governanceRecord.listRecords(TENANT_A);
      expect(all.length).toBe(4);
    });

    it('supports filtering historical records by disposition', async () => {
      await c6.govern({ condition: 'p1', confidence_tag: ConfidenceTag.HIGH }, TENANT_A);
      await c6.govern({ condition: 'p2', confidence_tag: ConfidenceTag.HIGH }, TENANT_A);
      await c6.govern({ condition: 'r1', appropriate: false }, TENANT_A);

      const published = await governanceRecord.listRecords(TENANT_A, {
        disposition: Disposition.PUBLISH,
      });
      const rejected = await governanceRecord.listRecords(TENANT_A, {
        disposition: Disposition.REJECT_AND_RECORD,
      });
      expect(published.length).toBe(2);
      expect(rejected.length).toBe(1);
    });
  });

  describe('Acceptance: tenant isolation', () => {
    it("a tenant's governance records are not visible to another tenant", async () => {
      const { record } = await c6.govern(
        { condition: 'tenant A private situational inference' },
        TENANT_A,
      );

      // Same id under tenant B must not resolve.
      const leaked = await governanceRecord.getRecord(TENANT_B, record.id as string);
      expect(leaked).toBeNull();

      // Tenant B's list is empty; tenant A's contains the record.
      const bList = await governanceRecord.listRecords(TENANT_B);
      const aList = await governanceRecord.listRecords(TENANT_A);
      expect(bList.length).toBe(0);
      expect(aList.length).toBe(1);
    });
  });
});
