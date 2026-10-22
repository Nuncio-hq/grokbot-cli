import { describe, expect, it } from "vitest";
import { GrokBotError } from "./contracts.js";
import { appLanguage, resolveSendLocale } from "./send-locale.js";

const MAC = { platform: "darwin", timeZone: "Europe/Berlin", locale: "de-DE" };
const LINUX = { ...MAC, platform: "linux" };
const ENV = (value: string) => ({ GROKBOT_TIMEZONE: value });

function failure(attempt: () => unknown): GrokBotError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof GrokBotError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("the time zone a message carries", () => {
  it.each([
    ["the env name on a Mac", ENV("Asia/Tokyo"), MAC, "Asia/Tokyo"],
    ["the env name off macOS", ENV("Asia/Tokyo"), LINUX, "Asia/Tokyo"],
    [
      "the env name in its canonical case",
      ENV(" europe/paris "),
      LINUX,
      "Europe/Paris",
    ],
    ["UTC when the env says UTC", ENV("UTC"), LINUX, "UTC"],
    ["the system zone on a Mac with no env", {}, MAC, "Europe/Berlin"],
    [
      "the system zone on a Mac with a blank env",
      ENV("  "),
      MAC,
      "Europe/Berlin",
    ],
  ])("is %s", (_, env, system, timeZone) => {
    expect(resolveSendLocale(env, system).timeZone).toBe(timeZone);
  });

  it.each([
    ["off", ENV("off"), MAC],
    ["off in any case", ENV("Off"), MAC],
    ["a Linux machine with no env", {}, LINUX],
    ["a Windows machine with no env", {}, { ...MAC, platform: "win32" }],
    [
      "a Mac whose own zone is no zone name",
      {},
      { ...MAC, timeZone: "Not/AZone" },
    ],
  ])("is absent for %s", (_, env, system) => {
    expect(resolveSendLocale(env, system)).not.toHaveProperty("timeZone");
  });

  it.each(["Mars/Base", "Europe", "+01:00", "-05:00", "Berlin time"])(
    "fails the send for GROKBOT_TIMEZONE=%s, naming the variable and the way out",
    (value) => {
      const { message } = failure(() => resolveSendLocale(ENV(value), MAC));
      expect(message).toContain("GROKBOT_TIMEZONE");
      expect(message).toContain(JSON.stringify(value));
      expect(message).toContain("GROKBOT_TIMEZONE=off");
      expect(message).toContain("Nothing was sent");
    },
  );

  it("fails for a bad env name even where no zone would be sent", () => {
    expect(
      failure(() => resolveSendLocale(ENV("Mars/Base"), LINUX)),
    ).toBeInstanceOf(GrokBotError);
  });
});

describe("the language a message carries", () => {
  it.each([
    ["en-US", "en"],
    ["en", "en"],
    ["pt-BR", "pt"],
    ["pt-PT", "pt"],
    ["de-DE", "de"],
    ["de_AT", "de"],
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["yue-Hans-CN", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["yue-HK", "zh-TW"],
    ["yue", "zh-TW"],
    ["nb-NO", "nb"],
    ["no", "nb"],
    ["nn-NO", "nb"],
    ["he-IL", "he"],
    ["iw", "he"],
    ["id-ID", "id"],
    ["in", "id"],
  ])("maps %s to %s", (tag, code) => {
    expect(appLanguage(tag)).toBe(code);
  });

  it("maps every language the app ships to itself", () => {
    const shipped =
      "af ar bn cs da de el en es fi fr ha he hi hu id it ja ko mr nb nl pl pt ru sv sw ta te th tr uk ur vi zh-CN zh-TW".split(
        " ",
      );
    expect(shipped.map((code) => appLanguage(code))).toEqual(shipped);
  });

  it.each(["fil-PH", "eo", "english", "zh-Latn", ""])(
    "has no language for %j",
    (tag) => {
      expect(appLanguage(tag)).toBeUndefined();
    },
  );

  it("is sent on a Mac, from the system locale", () => {
    expect(resolveSendLocale({}, { ...MAC, locale: "zh-Hant-TW" })).toEqual({
      timeZone: "Europe/Berlin",
      language: "zh-TW",
    });
  });

  it("is left out off macOS, even for a locale the app has", () => {
    expect(resolveSendLocale({}, { ...LINUX, locale: "de-DE" })).toEqual({});
  });

  it("is left out on a Mac for a locale the app has no language for", () => {
    expect(resolveSendLocale({}, { ...MAC, locale: "fil-PH" })).toEqual({
      timeZone: "Europe/Berlin",
    });
  });

  it("is still sent when GROKBOT_TIMEZONE=off withholds the zone", () => {
    expect(resolveSendLocale(ENV("off"), MAC)).toEqual({ language: "de" });
  });
});
