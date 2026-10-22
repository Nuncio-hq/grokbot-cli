import { GrokBotError } from "./contracts.js";

/** Sets the time zone sent with a message (an IANA name); `off` sends none. */
export const TIMEZONE_ENV = "GROKBOT_TIMEZONE";
/** The header the app sends the time zone in; the server keeps the last one for the whole account. */
export const TIMEZONE_HEADER = "x-cursor-timezone";

/** What this computer says about itself. Each field defaults to the real value; tests pass their own. */
export interface SystemLocale {
  /** Default: process.platform. */
  readonly platform?: string;
  /** The system's IANA time zone. Default: Intl.DateTimeFormat().resolvedOptions().timeZone. */
  readonly timeZone?: string;
  /** The system's locale as a BCP 47 tag, such as en-US or zh-Hant-TW. Default: Intl.DateTimeFormat().resolvedOptions().locale. */
  readonly locale?: string;
}

/** What goes out with a message besides its text, as the app sends it. */
export interface SendLocale {
  /** The `x-cursor-timezone` header value. */
  readonly timeZone?: string;
  /** The body field `language`: one of the app's language codes. */
  readonly language?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The canonical IANA name of `name`, or undefined when it is not a time zone name (offsets such as +01:00 are not). */
function ianaName(name: string): string | undefined {
  if (/^[+-]/.test(name)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The time zone to send: `GROKBOT_TIMEZONE` when it names one, nothing when it is `off`,
 * else the system zone, on macOS only. The server keeps the last zone it was sent for the
 * whole account, so a Linux machine (a CI box, the bots' cloud computer) must not send its
 * own, which would replace the owner's. Throws before anything is sent when the variable
 * holds something that is not a zone name.
 */
function timeZoneToSend(env: Env, system: SystemLocale): string | undefined {
  const setting = env[TIMEZONE_ENV]?.trim();
  if (setting) {
    if (setting.toLowerCase() === "off") return undefined;
    const zone = ianaName(setting);
    if (zone !== undefined) return zone;
    throw new GrokBotError(
      "protocol",
      `${TIMEZONE_ENV} is ${JSON.stringify(setting)}, which is not an IANA time zone name such as Europe/Berlin. Fix it, or set ${TIMEZONE_ENV}=off to send no time zone. Nothing was sent.`,
    );
  }
  if ((system.platform ?? process.platform) !== "darwin") return undefined;
  const systemZone =
    system.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return systemZone === undefined ? undefined : ianaName(systemZone);
}

/** Language codes the app lists that match by their first subtag alone, with the subtags that also mean them. */
const LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  pl: ["pl"],
  es: ["es"],
  hi: ["hi"],
  pt: ["pt"],
  ja: ["ja"],
  fr: ["fr"],
  ko: ["ko"],
  de: ["de"],
  ru: ["ru"],
  tr: ["tr"],
  ar: ["ar"],
  it: ["it"],
  sv: ["sv"],
  uk: ["uk"],
  nl: ["nl"],
  el: ["el"],
  af: ["af"],
  he: ["he", "iw"],
  vi: ["vi"],
  id: ["id", "in"],
  ur: ["ur"],
  th: ["th"],
  bn: ["bn"],
  cs: ["cs"],
  hu: ["hu"],
  nb: ["nb", "no", "nn"],
  da: ["da"],
  fi: ["fi"],
  mr: ["mr"],
  te: ["te"],
  sw: ["sw"],
  ha: ["ha"],
  ta: ["ta"],
  en: ["en"],
};

const HANS = ["zh-hans", "yue-hans"];
const HANT = ["zh-hant", "yue-hant"];
const SIMPLIFIED = ["zh", "zh-cn", "zh-sg", "yue-cn"];
const TRADITIONAL = ["zh-tw", "zh-hk", "zh-mo", "yue", "yue-hk", "yue-mo"];

const startsWithTag = (tag: string, tags: readonly string[]) =>
  tags.some((t) => tag === t || tag.startsWith(`${t}-`));

/**
 * The app's language code for a system locale tag, by the app's own rules (0.75.0): the
 * Chinese scripts and regions go to zh-CN or zh-TW, any other tag by its first subtag.
 * Undefined when the app has no such language.
 */
export function appLanguage(tag: string): string | undefined {
  const lower = tag.trim().toLowerCase().replaceAll("_", "-");
  if (SIMPLIFIED.includes(lower) || startsWithTag(lower, HANS)) return "zh-CN";
  if (TRADITIONAL.includes(lower) || startsWithTag(lower, HANT)) return "zh-TW";
  return Object.entries(LANGUAGES).find(([, subtags]) =>
    startsWithTag(lower, subtags),
  )?.[0];
}

/** The language to send, on macOS only; nothing off macOS or for a locale the app has no language for. */
function languageToSend(system: SystemLocale): string | undefined {
  if ((system.platform ?? process.platform) !== "darwin") return undefined;
  const locale =
    system.locale ?? new Intl.DateTimeFormat().resolvedOptions().locale;
  return locale === undefined ? undefined : appLanguage(locale);
}

/**
 * What a message carries besides its text, decided once for every SendGrokBotUserMessage
 * call. Throws a GrokBotError for an invalid `GROKBOT_TIMEZONE`.
 */
export function resolveSendLocale(
  env: Env = process.env,
  system: SystemLocale = {},
): SendLocale {
  const timeZone = timeZoneToSend(env, system);
  const language = languageToSend(system);
  return {
    ...(timeZone !== undefined && { timeZone }),
    ...(language !== undefined && { language }),
  };
}
