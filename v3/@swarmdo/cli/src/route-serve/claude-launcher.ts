/**
 * Claude Code launcher settings for the route-serve proxy.
 *
 * `route serve` speaks Anthropic `/v1/messages` over the OpenRouter pool, but
 * pointing Claude Code at it was a manual `ANTHROPIC_BASE_URL=… claude`: the
 * pool stayed invisible, `/model` still listed the built-in Anthropic models,
 * and subagents inherited the main model instead of a cheap one.
 *
 * Claude Code reads a settings file (`claude --settings <file>`) that can both
 * set `env` and REPLACE the model picker, so the pool can be presented as the
 * model list. Two kinds of entry are offered, and the difference is load-bearing:
 *
 *   - TIER sentinels ('haiku' | 'sonnet' | 'opus') — `tierForRequest` maps them
 *     to a tier and the proxy Thompson-samples within it, so picking one keeps
 *     LEARNED routing (the shared per-modelId priors keep maturing).
 *   - EXACT pool slugs ('deepseek/deepseek-chat') — `resolveOpenRouterModel`
 *     short-circuits on anything `isOpenRouterSlug` accepts and returns it with
 *     source 'explicit', so picking one PINS that model and skips sampling.
 *
 * Nothing here talks to the network: `renderClaudeSettings` is pure so the
 * mapping is unit-testable without a proxy, a pool key, or Claude Code.
 */

import type { OpenRouterConfig, RoutingTier } from '../providers/openrouter-config.js';
import { modelsForTier } from '../providers/openrouter-config.js';

/** Tiers in cheap→expensive order. Also the fallback search order when a tier
 *  named in the picker has no models behind it. */
export const TIER_ORDER: RoutingTier[] = ['haiku', 'sonnet', 'opus'];

const TIER_LABEL: Record<RoutingTier, string> = {
  haiku: 'Swarmdo Fast',
  sonnet: 'Swarmdo Balanced',
  opus: 'Swarmdo Deep',
};

export interface ClaudeLauncherOptions {
  /** The parsed OpenRouter pool — supplies the picker entries. */
  cfg: OpenRouterConfig;
  /** Proxy base URL: the local `route serve`, or any Anthropic-compatible host. */
  baseUrl: string;
  /** Token sent as ANTHROPIC_AUTH_TOKEN. See `resolveAuthToken` for why this is
   *  never left unset. */
  authToken?: string;
  /** Model for Claude Code's subagents. Defaults to the cheapest live tier. */
  subagentModel?: string;
}

export interface ModelPickerOption {
  model: string;
  label: string;
  description: string;
}

export interface ClaudeSettings {
  env: Record<string, string>;
  modelPicker: { replaceBuiltInOptions: true; options: ModelPickerOption[] };
}

/** Tiers that actually have a model behind them, cheap→expensive.
 *  A tier with no models must never be offered: `pickOpenRouterModel` returns
 *  null for it, and the request then dead-ends on `defaultModel` or a 5xx. */
export function liveTiers(cfg: OpenRouterConfig): RoutingTier[] {
  return TIER_ORDER.filter((t) => modelsForTier(cfg, t).length > 0);
}

/**
 * ANTHROPIC_AUTH_TOKEN is ALWAYS set, falling back to a local placeholder.
 *
 * Leaving it unset makes Claude Code authenticate to whatever ANTHROPIC_BASE_URL
 * points at using the user's real Anthropic credentials — fine for localhost,
 * but this same launcher aims at remote Anthropic-compatible endpoints, and
 * there it would hand the user's subscription token to a third-party host.
 * An explicit value keeps the real credential out of the request either way.
 */
export function resolveAuthToken(authToken?: string): string {
  const t = (authToken ?? '').trim();
  return t.length > 0 ? t : 'swarmdo-route-local';
}

/** Short display name for a pool slug: 'deepseek/deepseek-chat' → 'deepseek-chat'. */
export function slugLabel(id: string): string {
  const tail = id.slice(id.lastIndexOf('/') + 1);
  return tail.length > 0 ? tail : id;
}

/** The picker list: every live tier (learned routing) then every pool model
 *  (pinned). Order matters — Claude Code shows option 1 as the default. */
export function buildPickerOptions(cfg: OpenRouterConfig): ModelPickerOption[] {
  const tiers = liveTiers(cfg);
  const options: ModelPickerOption[] = tiers.map((tier) => {
    const n = modelsForTier(cfg, tier).length;
    return {
      model: tier,
      label: TIER_LABEL[tier],
      description: `Learned routing across ${n} ${tier}-tier model${n === 1 ? '' : 's'}`,
    };
  });
  const seen = new Set<string>();
  for (const m of cfg.models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    options.push({
      model: m.id,
      label: slugLabel(m.id),
      description: `Pinned · ${m.id}${m.tier ? ` · ${m.tier} tier` : ''}`,
    });
  }
  return options;
}

/** Which tier sentinel a Claude family should resolve to. Falls back to the
 *  nearest live tier so an unconfigured tier never dead-ends a request. */
export function tierSentinelFor(cfg: OpenRouterConfig, want: RoutingTier): RoutingTier | null {
  const live = liveTiers(cfg);
  if (live.length === 0) return null;
  if (live.includes(want)) return want;
  // Nearest by position in the cheap→expensive ladder.
  const wantIdx = TIER_ORDER.indexOf(want);
  let best = live[0];
  let bestDist = Math.abs(TIER_ORDER.indexOf(best) - wantIdx);
  for (const t of live.slice(1)) {
    const d = Math.abs(TIER_ORDER.indexOf(t) - wantIdx);
    if (d < bestDist) { best = t; bestDist = d; }
  }
  return best;
}

/**
 * Render the Claude Code settings document for a pool behind `baseUrl`.
 * Pure — no fs, no network, no env reads.
 */
export function renderClaudeSettings(opts: ClaudeLauncherOptions): ClaudeSettings {
  const { cfg, baseUrl } = opts;
  const live = liveTiers(cfg);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: resolveAuthToken(opts.authToken),
  };

  // Map each Claude family Claude Code may ask for onto a live tier sentinel,
  // so the built-in model names keep working alongside the picker entries.
  const families: Array<[RoutingTier, string]> = [
    ['haiku', 'HAIKU'],
    ['sonnet', 'SONNET'],
    ['opus', 'OPUS'],
  ];
  for (const [tier, key] of families) {
    const sentinel = tierSentinelFor(cfg, tier);
    if (!sentinel) continue;
    const n = modelsForTier(cfg, sentinel).length;
    env[`ANTHROPIC_DEFAULT_${key}_MODEL`] = sentinel;
    env[`ANTHROPIC_DEFAULT_${key}_MODEL_NAME`] = TIER_LABEL[sentinel];
    env[`ANTHROPIC_DEFAULT_${key}_MODEL_DESCRIPTION`] =
      `Learned routing across ${n} ${sentinel}-tier model${n === 1 ? '' : 's'}`;
  }

  // Subagents default to the cheapest live tier — fan-out is where the pool's
  // cost advantage actually lands, and it is the one knob `route serve` could
  // never reach from an env var alone.
  const subagent = opts.subagentModel ?? live[0];
  if (subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent;

  return {
    env,
    modelPicker: { replaceBuiltInOptions: true, options: buildPickerOptions(cfg) },
  };
}
