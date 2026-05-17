import { describe, it, expect } from "vitest";
import {
  extractBundleUrl,
  extractAppId,
  extractAppSecret,
} from "../src/providers/qobuz/credentials.js";

// Synthetic fixture exercising the exact regexes/algorithm ported from
// qobuz-api web.rs. secret "qobuz_test_secret" -> base64 "cW9idXpfdGVzdF9zZWNyZXQ="
// (24 chars). concat = seed(b64) + info("") + extras(44×"A"); dropping the
// last 44 chars yields the b64, which decodes back to the secret.
const B64 = "cW9idXpfdGVzdF9zZWNyZXQ=";
const EXTRAS = "A".repeat(44);

const LOGIN_HTML = `<!doctype html><html><head>
<script src="/resources/v2/bundle-9f8a.js"></script></head><body></body></html>`;

const BUNDLE_JS = `
!function(){var x={production:{api:{appId:"123456789",appSecret:"ignored"}}};
function f(){return g():a.initialSeed("${B64}",window.utimezone.berlin)}
window.utimezone={berlin:{name:"Europe/Berlin",info:"",extras:"${EXTRAS}"}};
}();`;

describe("qobuz credential extraction (port of web.rs)", () => {
  it("extracts the bundle URL from the login page", () => {
    expect(extractBundleUrl(LOGIN_HTML)).toBe(
      "https://play.qobuz.com/resources/v2/bundle-9f8a.js",
    );
  });

  it("throws a ProviderError when bundle URL is absent", () => {
    expect(() => extractBundleUrl("<html>nope</html>")).toThrow(
      /could not find bundle\.js URL/,
    );
  });

  it("extracts the production appId", () => {
    expect(extractAppId(BUNDLE_JS)).toBe("123456789");
  });

  it("derives the app secret via the seed/timezone base64 dance", () => {
    expect(extractAppSecret(BUNDLE_JS)).toBe("qobuz_test_secret");
  });

  it("throws when the timezone object is missing", () => {
    const broken = BUNDLE_JS.replace("Europe/Berlin", "Europe/Paris");
    expect(() => extractAppSecret(broken)).toThrow(/timezone object/);
  });
});
