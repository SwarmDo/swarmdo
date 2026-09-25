/**
 * route claude — the Claude Code settings renderer.
 * Engine-first: `renderClaudeSettings` is pure, so the whole mapping is checked
 * with no fs, no proxy, no Claude Code on PATH.
 */
import { describe, it, expect } from 'vitest';
import type { OpenRouterConfig } from '../src/providers/openrouter-config.ts';
import {
  renderClaudeSettings,
  buildPickerOptions,
  liveTiers,
  tierSentinelFor,
  resolveAuthToken,
  slugLabel,
} from '../src/route-serve/claude-launcher.ts';

const cfg = (models: OpenRouterConfig['models']): OpenRouterConfig =>
  ({ enabled: true, models } as OpenRouterConfig);

const full = cfg([
  { id: 'meta-llama/llama-3.3-70b-instruct', tier: 'haiku' },
  { id: 'deepseek/deepseek-chat', tier: 'sonnet' },
  { id: 'z-ai/glm-4.6', tier: 'sonnet' },
  { id: 'anthropic/claude-opus-4-5', tier: 'opus' },
]);

describe('liveTiers', () => {
  it('reports only tiers that have a model, cheap first', () => {
    expect(liveTiers(full)).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('omits a tier with no models', () => {
    expect(liveTiers(cfg([{ id: 'a/b', tier: 'sonnet' }]))).toEqual(['sonnet']);
  });

  it('is empty when nothing carries a tier', () => {
    expect(liveTiers(cfg([{ id: 'a/b' }]))).toEqual([]);
  });
});

describe('tierSentinelFor', () => {
  it('returns the tier itself when it is live', () => {
    expect(tierSentinelFor(full, 'opus')).toBe('opus');
  });

  it('falls back to the nearest live tier so a request never dead-ends', () => {
    const sonnetOnly = cfg([{ id: 'a/b', tier: 'sonnet' }]);
    expect(tierSentinelFor(sonnetOnly, 'haiku')).toBe('sonnet');
    expect(tierSentinelFor(sonnetOnly, 'opus')).toBe('sonnet');
  });

  it('prefers the closer rung when two are live', () => {
    const ends = cfg([
      { id: 'a/b', tier: 'haiku' },
      { id: 'c/d', tier: 'opus' },
    ]);
    // sonnet sits between them; haiku is index 0, opus index 2, sonnet index 1 —
    // equidistant, so the first live tier (cheapest) wins.
    expect(tierSentinelFor(ends, 'sonnet')).toBe('haiku');
  });

  it('returns null when no tier is live', () => {
    expect(tierSentinelFor(cfg([{ id: 'a/b' }]), 'sonnet')).toBeNull();
  });
});

describe('slugLabel', () => {
  it('uses the slug tail', () => {
    expect(slugLabel('deepseek/deepseek-chat')).toBe('deepseek-chat');
  });
  it('passes through a slug with no owner', () => {
    expect(slugLabel('local-model')).toBe('local-model');
  });
  it('falls back to the whole id on a trailing slash', () => {
    expect(slugLabel('vendor/')).toBe('vendor/');
  });
});

describe('resolveAuthToken', () => {
  it('never returns empty — an unset token would send real Anthropic credentials upstream', () => {
    expect(resolveAuthToken(undefined)).toBe('swarmdo-route-local');
    expect(resolveAuthToken('   ')).toBe('swarmdo-route-local');
  });
  it('keeps an explicit token', () => {
    expect(resolveAuthToken('sk-abc')).toBe('sk-abc');
  });
});

describe('buildPickerOptions', () => {
  it('lists live tiers first, then every pool model', () => {
    const opts = buildPickerOptions(full);
    expect(opts.slice(0, 3).map((o) => o.model)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(opts.slice(3).map((o) => o.model)).toEqual(full.models.map((m) => m.id));
  });

  it('counts the models behind each tier', () => {
    const sonnet = buildPickerOptions(full).find((o) => o.model === 'sonnet');
    expect(sonnet?.description).toContain('2 sonnet-tier models');
  });

  it('singularises a one-model tier', () => {
    const opus = buildPickerOptions(full).find((o) => o.model === 'opus');
    expect(opus?.description).toContain('1 opus-tier model');
    expect(opus?.description).not.toContain('models');
  });

  it('de-duplicates repeated slugs', () => {
    const dup = cfg([
      { id: 'a/b', tier: 'sonnet' },
      { id: 'a/b', tier: 'sonnet' },
    ]);
    expect(buildPickerOptions(dup).filter((o) => o.model === 'a/b')).toHaveLength(1);
  });
});

describe('renderClaudeSettings', () => {
  const s = renderClaudeSettings({ cfg: full, baseUrl: 'http://127.0.0.1:3456' });

  it('points Claude Code at the proxy and always sets a token', () => {
    expect(s.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3456');
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe('swarmdo-route-local');
  });

  it('maps each Claude family onto a tier sentinel, which keeps learned routing', () => {
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku');
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet');
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus');
  });

  it('names and describes each family entry', () => {
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('Swarmdo Balanced');
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION).toContain('2 sonnet-tier models');
  });

  it('defaults subagents to the cheapest live tier', () => {
    expect(s.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku');
  });

  it('honours an explicit subagent model', () => {
    const pinned = renderClaudeSettings({
      cfg: full,
      baseUrl: 'http://x',
      subagentModel: 'deepseek/deepseek-chat',
    });
    expect(pinned.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek/deepseek-chat');
  });

  it('replaces the built-in picker rather than appending to it', () => {
    expect(s.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(s.modelPicker.options).toHaveLength(3 + full.models.length);
  });

  it('never points a family at a tier with no models', () => {
    const sonnetOnly = cfg([{ id: 'a/b', tier: 'sonnet' }]);
    const only = renderClaudeSettings({ cfg: sonnetOnly, baseUrl: 'http://x' });
    expect(only.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('sonnet');
    expect(only.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('sonnet');
    expect(only.modelPicker.options.filter((o) => o.model === 'haiku')).toHaveLength(0);
  });

  it('omits the family vars entirely when no tier is live', () => {
    const untiered = renderClaudeSettings({ cfg: cfg([{ id: 'a/b' }]), baseUrl: 'http://x' });
    expect(untiered.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(untiered.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    // The slug is still offered as a pinned pick.
    expect(untiered.modelPicker.options.map((o) => o.model)).toEqual(['a/b']);
  });

  it('carries an explicit token through for a remote endpoint', () => {
    const remote = renderClaudeSettings({ cfg: full, baseUrl: 'https://example.invalid', authToken: 'sk-live' });
    expect(remote.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-live');
    expect(remote.env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
  });
});

/**
 * Regression: Claude Code appends a bracketed context marker ('sonnet' is sent
 * as 'sonnet[1m]'). Tier mapping survived it by substring luck; slug PINNING
 * did not, so a pinned pick from the model picker silently became tier routing.
 * Found by running `route claude` end to end against a live proxy.
 */
describe('normalizeModelHint (1m-suffix regression)', () => {
  it('strips the context marker', async () => {
    const { normalizeModelHint } = await import('../src/route-serve/proxy.ts');
    expect(normalizeModelHint('sonnet[1m]')).toBe('sonnet');
    expect(normalizeModelHint('deepseek/deepseek-chat[1m]')).toBe('deepseek/deepseek-chat');
  });

  it('leaves an unsuffixed model alone', async () => {
    const { normalizeModelHint } = await import('../src/route-serve/proxy.ts');
    expect(normalizeModelHint('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
    expect(normalizeModelHint(undefined)).toBe('');
  });

  it('a suffixed pool slug still PINS that exact model', async () => {
    const { selectModelForRequest } = await import('../src/route-serve/proxy.ts');
    const picked = selectModelForRequest(
      { model: 'deepseek/deepseek-chat[1m]', messages: [] } as never,
      full,
    );
    expect(picked?.model).toBe('deepseek/deepseek-chat');
    expect(picked?.source).toBe('explicit');
  });

  it('a suffixed tier sentinel still resolves to that tier', async () => {
    const { tierForRequest } = await import('../src/route-serve/proxy.ts');
    expect(tierForRequest({ model: 'haiku[1m]' })).toBe('haiku');
    expect(tierForRequest({ model: 'opus[1m]' })).toBe('opus');
  });
});
