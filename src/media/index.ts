/**
 * MEDIA GENERATION — pluggable provider layer.
 *
 * IMPORTANT / HONEST DESIGN NOTE:
 * The DRCS engine generates CAPTIONS at runtime via a real text-LLM HTTP API
 * (see `src/llm`, used by C5). It does NOT bundle a runtime image/video
 * generator, because no image-generation HTTP endpoint is available to the
 * deployed Node process out of the box. Rather than fake one, media generation
 * is exposed as a PLUGGABLE PROVIDER that an operator injects.
 *
 * By DEFAULT the engine uses {@link NullMediaGenerator}, which produces no file.
 * In that mode a C5-generated caption is returned together with an
 * `asset_recommendation` (a description of the visual that would pair with it)
 * and, when the resolved category already has a registered asset file, that real
 * file is reused. No image is fabricated.
 *
 * To make the engine actually CREATE new media, an operator wraps their own
 * backend (e.g. DALL·E, Stable Diffusion, Replicate, or an internal render
 * service) in a {@link MediaGenerator} and registers it once at startup:
 *
 * ```ts
 * import { setMediaGenerator } from 'drcs-engine';
 *
 * setMediaGenerator({
 *   async generate({ tenant_id, caption, category, asset_recommendation }) {
 *     const file_path = await myImageBackend.render(asset_recommendation, caption);
 *     return { file_path };            // return null to decline / on failure
 *   },
 * });
 * ```
 *
 * The orchestrator calls the registered generator after C5 produces a caption;
 * if it returns null (the default), the pipeline still returns the caption and
 * any reusable asset file — it never fails just because no image was created.
 */

/** Input handed to a media generator after C5 produces a caption. */
export interface MediaGenerationInput {
  /** Tenant the request belongs to (scopes any per-tenant backend/config). */
  tenant_id: string;
  /** The freshly generated caption the media should visually support. */
  caption: string;
  /** The resolved situational category (e.g. "victory"). */
  category: string;
  /** C5's short description of the clip/image that would pair well. */
  asset_recommendation: string;
}

/**
 * A pluggable backend that turns a generated caption + recommendation into a
 * concrete media file. Operators implement this to connect their own image or
 * video backend.
 */
export interface MediaGenerator {
  /**
   * Produce a media file for the request.
   * @returns `{ file_path }` pointing at the created file (a path or URL), or
   * `null` to decline (no backend configured, or generation failed). Returning
   * null is safe: the pipeline continues with the caption + any reusable asset.
   */
  generate(input: MediaGenerationInput): Promise<{ file_path: string } | null>;
}

/**
 * The safe default provider: never creates a file. This is what ships out of
 * the box, because the engine bundles no runtime image backend. It makes the
 * "caption + recommendation, reuse existing asset files" behaviour explicit
 * rather than pretending an image was generated.
 */
export class NullMediaGenerator implements MediaGenerator {
  async generate(_input: MediaGenerationInput): Promise<{ file_path: string } | null> {
    return null;
  }
}

/** The process-wide active generator. Defaults to the no-op provider. */
let activeGenerator: MediaGenerator = new NullMediaGenerator();

/**
 * Register the media generator the orchestrator should use. Call once at
 * startup to plug in a real image/video backend.
 */
export function setMediaGenerator(generator: MediaGenerator): void {
  activeGenerator = generator;
}

/** Get the currently registered media generator (the no-op provider by default). */
export function getMediaGenerator(): MediaGenerator {
  return activeGenerator;
}

/** Reset back to the default {@link NullMediaGenerator}. Mainly for tests. */
export function resetMediaGenerator(): void {
  activeGenerator = new NullMediaGenerator();
}
