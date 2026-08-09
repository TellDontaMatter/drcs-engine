/**
 * MEDIA PROVIDER — pluggable media generator tests.
 *
 * Proves the engine ships with a safe no-op default (no runtime image backend
 * is bundled), that an operator can register their own generator, and that when
 * one is registered the orchestrator uses the file it returns for a fresh
 * C5-generated caption. All LLM calls are mocked — no network.
 */
import {
  NullMediaGenerator,
  setMediaGenerator,
  getMediaGenerator,
  resetMediaGenerator,
  MediaGenerator,
} from '../src/media';
import { evaluate, EvaluationOutcome } from '../src/orchestrator';
import * as categorySchema from '../src/persistence/repositories/categorySchema';
import * as llm from '../src/llm';

function mockLLM(response: string): jest.SpyInstance {
  return jest.spyOn(llm, 'callLLM').mockResolvedValue(response);
}

const TENANT = 'zilly';

describe('Media provider — default + registry', () => {
  afterEach(() => {
    resetMediaGenerator();
    jest.restoreAllMocks();
  });

  it('NullMediaGenerator produces no file (safe default)', async () => {
    const out = await new NullMediaGenerator().generate({
      tenant_id: TENANT,
      caption: 'hi',
      category: 'victory',
      asset_recommendation: 'a clip',
    });
    expect(out).toBeNull();
  });

  it('defaults to the no-op provider until one is registered', async () => {
    const def = await getMediaGenerator().generate({
      tenant_id: TENANT,
      caption: 'hi',
      category: 'victory',
      asset_recommendation: 'a clip',
    });
    expect(def).toBeNull();
  });

  it('setMediaGenerator / getMediaGenerator round-trips, resetMediaGenerator restores default', async () => {
    const stub: MediaGenerator = {
      async generate() {
        return { file_path: 'media/assets/x.png' };
      },
    };
    setMediaGenerator(stub);
    expect(getMediaGenerator()).toBe(stub);
    resetMediaGenerator();
    const back = await getMediaGenerator().generate({
      tenant_id: TENANT,
      caption: 'hi',
      category: 'victory',
      asset_recommendation: 'a clip',
    });
    expect(back).toBeNull();
  });
});

describe('Media provider — orchestrator integration', () => {
  afterEach(() => {
    resetMediaGenerator();
    jest.restoreAllMocks();
  });

  it('uses an injected generator’s file for a C5-generated caption', async () => {
    mockLLM(
      JSON.stringify({
        caption: 'Fresh generated line!',
        asset_recommendation: 'An energetic celebration image.',
      }),
    );
    // Empty category → C4 escalates → C5 generates. No asset to reuse, so the
    // only way file_path becomes non-null is via the injected media generator.
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'adversity',
      name: 'adversity',
      prestocked_flag: true,
      asset_list: [],
    });

    const received: string[] = [];
    setMediaGenerator({
      async generate(input) {
        received.push(input.caption);
        return { file_path: 'media/assets/generated_demo.png' };
      },
    });

    const v = await evaluate(
      {
        trigger: { condition: 'tough day' },
        condition_signal: { category_id: 'adversity' },
        content_need: { caption: 'Push through.' },
      },
      TENANT,
    );

    expect(v.outcome).toBe(EvaluationOutcome.GENERATED);
    expect(v.source).toBe('GENERATED');
    expect(v.caption).toBe('Fresh generated line!');
    // The injected generator supplied the media file.
    expect(v.file_path).toBe('media/assets/generated_demo.png');
    // And it received the freshly generated caption.
    expect(received).toEqual(['Fresh generated line!']);
  });

  it('a throwing generator never sinks the request (caption still returned)', async () => {
    mockLLM(
      JSON.stringify({ caption: 'Still fine.', asset_recommendation: 'a clip' }),
    );
    await categorySchema.upsertCategory({
      tenant_id: TENANT,
      category_id: 'adversity',
      name: 'adversity',
      prestocked_flag: true,
      asset_list: [],
    });
    setMediaGenerator({
      async generate() {
        throw new Error('backend exploded');
      },
    });

    const v = await evaluate(
      {
        trigger: { condition: 'tough day' },
        condition_signal: { category_id: 'adversity' },
        content_need: { caption: 'Push through.' },
      },
      TENANT,
    );

    expect(v.outcome).toBe(EvaluationOutcome.GENERATED);
    expect(v.caption).toBe('Still fine.');
    expect(v.file_path).toBeNull();
  });
});
