import { describe, test, expect } from "bun:test";
import { checkUrl, htmlToText, isBlockedAddress, webFetchTool } from "./web-fetch.ts";
import { checkPermission, planModeBlocks } from "../permissions/gate.ts";

describe("address blocking", () => {
  test("loopback, private and link-local IPv4 are refused", () => {
    for (const address of [
      "127.0.0.1", "127.1.2.3",
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint — the reason this exists
      "0.0.0.0",
      "100.64.0.1",     // CGNAT
      "224.0.0.1",      // multicast
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test("public IPv4 is allowed", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1"]) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });

  test("IPv6 loopback, link-local and unique-local are refused", () => {
    for (const address of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1"]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test("an IPv4-mapped IPv6 address is unwrapped rather than waved through", () => {
    // ::ffff:127.0.0.1 is loopback wearing a costume.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("public IPv6 is allowed", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });

  test("anything that is not an address at all is refused", () => {
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("URL checking", () => {
  test("a literal private address is refused without a DNS lookup", async () => {
    const result = await checkUrl("http://127.0.0.1:8080/admin");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("private or loopback");
  });

  test("the cloud metadata endpoint is refused", async () => {
    const result = await checkUrl("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
  });

  test("a bracketed IPv6 loopback is refused", async () => {
    expect((await checkUrl("http://[::1]:9000/")).ok).toBe(false);
  });

  test("non-http schemes are refused", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com", "gopher://x"]) {
      const result = await checkUrl(url);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("only http and https");
    }
  });

  test("nonsense is refused rather than throwing", async () => {
    const result = await checkUrl("not a url at all");
    expect(result.ok).toBe(false);
  });

  test("a hostname that resolves to loopback is refused", async () => {
    // The attack a hostname blocklist cannot see: the name is innocuous and the
    // address is not. `localhost` stands in for `evil.com A 127.0.0.1`.
    const result = await checkUrl("http://localhost:3000/");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resolves to");
  });

  test("an unresolvable host is refused rather than attempted", async () => {
    const result = await checkUrl("https://definitely-not-a-real-host-xyz.invalid/");
    expect(result.ok).toBe(false);
  });
});

describe("HTML stripping", () => {
  test("script and style content is dropped entirely", () => {
    const text = htmlToText(
      "<html><head><style>body{color:red}</style><script>alert('x')</script></head><body><p>Hello</p></body></html>",
    );
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Hello");
  });

  test("block-level structure survives as newlines", () => {
    expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });

  test("entities are decoded", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toContain('a & b <c> "d"');
  });

  test("comments are dropped", () => {
    expect(htmlToText("<p>keep</p><!-- drop this -->")).toBe("keep");
  });
});

describe("web_fetch tool", () => {
  test("it is network-level, so it asks in every mode but yolo", () => {
    expect(webFetchTool.permissionLevel).toBe("network");
    expect(checkPermission("web_fetch", "network", "standard")).toBe("ask");
    expect(checkPermission("web_fetch", "network", "safe")).toBe("ask");
    expect(checkPermission("web_fetch", "network", "yolo")).toBe("allow");
  });

  test("plan mode denies it — a fetch leaves the machine", () => {
    expect(planModeBlocks("network", { url: "https://example.com" }).blocked).toBe(true);
  });

  test("a refused URL comes back as an error rather than an exception", async () => {
    const result = (await webFetchTool.execute({ url: "http://127.0.0.1/" })) as { error: string };
    expect(result.error).toContain("Refused to fetch");
  });

  test("a file:// URL is refused", async () => {
    const result = (await webFetchTool.execute({ url: "file:///etc/passwd" })) as { error: string };
    expect(result.error).toContain("Refused to fetch");
  });

  test("the byte cap is bounded by the schema", () => {
    expect(webFetchTool.parameters.safeParse({ url: "https://x.com", max_bytes: 999_999_999 }).success).toBe(false);
    expect(webFetchTool.parameters.safeParse({ url: "https://x.com", max_bytes: 1000 }).success).toBe(true);
  });
});
