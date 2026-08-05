/**
 * C5 — MISALIGNMENT PROTOCOL tests.
 *
 * C5 fires when C4 escalates and GENERATES a fresh caption via the LLM. All LLM
 * calls are mocked (spying on `llm.callLLM`) so no test makes a network call.
 */
import { generate, buildPrompt, parseGeneration } from '../src/gates/c5';
import * as llm from '../src/llm';
import { C5Request } from '../src/types';

const REQUEST: C5Request = {
  tenant_id: 'zilly',
  situation: 'We just hit a massive milestone',
  category: 'victory',
  content_type: 'clip',
};

describe('C5 — buildPrompt', () => {
  it('embeds tenant, category, situation and content type', () => {
    const p = buildPrompt(REQUEST);
    expect(p).toContain('zilly');
    expect(p).toContain('victory');
    expect(p).toContain('We just hit a massive milestone');
    expect(p).toContain('clip');
  });
});

describe('C5 — parseGeneration', () => {
  it('parses a clean JSON object', () => {
    const out = parseGeneration(
      '{"caption":"Big win!","asset_recommendation":"A confetti clip."}',
    );
    expect(out.caption).toBe('Big win!');
    expect(out.asset_recommendation).toBe('A confetti clip.');
  });

  it('parses JSON embedded in prose / code fences', () => {
    const out = parseGeneration(
      'Sure! Here you go:\n```json\n{"caption":"Nailed it","asset_recommendation":"A fist-pump clip"}\n```',
    );
    expect(out.caption).toBe('Nailed it');
    expect(out.asset_recommendation).toBe('A fist-pump clip');
  });

  it('falls back to treating the whole reply as the caption', () => {
    const out = parseGeneration('Just a plain caption with no JSON.');
    expect(out.caption).toBe('Just a plain caption with no JSON.');
    expect(out.asset_recommendation.length).toBeGreaterThan(0);
  });
});

describe('C5 — generate', () => {
  it('returns GENERATED with caption + recommendation on success', async () => {
    jest
      .spyOn(llm, 'callLLM')
      .mockResolvedValue(
        JSON.stringify({
          caption: 'You crushed it — celebrate!',
          asset_recommendation: 'An upbeat victory jump clip.',
        }),
      );
    const result = await generate(REQUEST);
    expect(result.action).toBe('GENERATED');
    if (result.action === 'GENERATED') {
      expect(result.caption).toBe('You crushed it — celebrate!');
      expect(result.asset_recommendation).toBe('An upbeat victory jump clip.');
    }
  });

  it('passes the built prompt to the LLM', async () => {
    const spy = jest
      .spyOn(llm, 'callLLM')
      .mockResolvedValue('{"caption":"c","asset_recommendation":"r"}');
    await generate(REQUEST);
    expect(spy).toHaveBeenCalledTimes(1);
    const [prompt] = spy.mock.calls[0];
    expect(prompt).toContain('victory');
  });

  it('returns ESCALATE_FAILED when the LLM throws', async () => {
    jest.spyOn(llm, 'callLLM').mockRejectedValue(new llm.LlmError('timeout'));
    const result = await generate(REQUEST);
    expect(result.action).toBe('ESCALATE_FAILED');
    if (result.action === 'ESCALATE_FAILED') {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns ESCALATE_FAILED when the model returns an empty caption', async () => {
    jest.spyOn(llm, 'callLLM').mockResolvedValue('   ');
    const result = await generate(REQUEST);
    expect(result.action).toBe('ESCALATE_FAILED');
  });

  it('returns ESCALATE_FAILED when the situation is empty (no LLM call)', async () => {
    const spy = jest.spyOn(llm, 'callLLM');
    const result = await generate({ ...REQUEST, situation: '  ' });
    expect(result.action).toBe('ESCALATE_FAILED');
    expect(spy).not.toHaveBeenCalled();
  });
});
