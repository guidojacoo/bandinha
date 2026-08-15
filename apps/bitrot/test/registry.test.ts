import { describe, expect, it } from "vitest";
import {
  isValidNpmName,
  normaliseLicense,
  normaliseNpmPackument,
  normaliseRepositoryUrl,
} from "../src/lib/registry/npm";
import {
  normalisePypiName,
  normalisePypiResponse,
  pickDevelopmentStatus,
  pickPypiRepository,
} from "../src/lib/registry/pypi";
import { mapWithConcurrency } from "../src/lib/registry";

describe("normaliseNpmPackument", () => {
  const base = {
    name: "demo",
    "dist-tags": { latest: "2.0.0" },
    versions: {
      "1.0.0": { version: "1.0.0" },
      "2.0.0": { version: "2.0.0", license: "MIT", repository: { url: "git+https://github.com/a/b.git" } },
    },
    time: {
      created: "2020-01-01T00:00:00.000Z",
      modified: "2024-01-01T00:00:00.000Z",
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "2.0.0": "2023-06-01T00:00:00.000Z",
    },
    maintainers: [{ name: "alice" }, { name: "bob" }],
  };

  it("extracts the fields the score depends on", () => {
    const pkg = normaliseNpmPackument(base);
    expect(pkg.name).toBe("demo");
    expect(pkg.latestVersion).toBe("2.0.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.maintainerCount).toBe(2);
    expect(pkg.maintainers).toEqual(["alice", "bob"]);
    expect(pkg.repositoryUrl).toBe("https://github.com/a/b");
  });

  /** `time` mixes bookkeeping keys in with the versions. */
  it("does not mistake created/modified for releases", () => {
    const pkg = normaliseNpmPackument(base);
    expect(pkg.releaseDates).toHaveLength(2);
    expect(pkg.releaseCount).toBe(2);
    expect(pkg.lastPublishAt).toBe("2023-06-01T00:00:00.000Z");
    expect(pkg.firstPublishAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("returns release dates in ascending order", () => {
    const pkg = normaliseNpmPackument({
      ...base,
      time: { "3.0.0": "2024-01-01T00:00:00.000Z", "1.0.0": "2020-01-01T00:00:00.000Z" },
    });
    expect(pkg.releaseDates).toEqual([
      "2020-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
    ]);
  });

  it("reads deprecation off the latest version", () => {
    const pkg = normaliseNpmPackument({
      ...base,
      versions: { "2.0.0": { version: "2.0.0", deprecated: "no longer maintained" } },
    });
    expect(pkg.deprecated).toBe(true);
    expect(pkg.deprecationNote).toBe("no longer maintained");
  });

  it("does not treat an empty deprecation string as deprecated", () => {
    const pkg = normaliseNpmPackument({
      ...base,
      versions: { "2.0.0": { version: "2.0.0", deprecated: "" } },
    });
    expect(pkg.deprecated).toBe(false);
  });

  it("throws on a packument with no latest tag", () => {
    expect(() => normaliseNpmPackument({ name: "x", versions: {} })).toThrow(/latest/);
  });
});

describe("normaliseLicense", () => {
  it("accepts the string, object and array shapes npm has used over the years", () => {
    expect(normaliseLicense("MIT")).toBe("MIT");
    expect(normaliseLicense({ type: "Apache-2.0", url: "http://x" })).toBe("Apache-2.0");
    expect(normaliseLicense([{ type: "MIT" }, { type: "GPL-3.0" }])).toBe("MIT OR GPL-3.0");
    expect(normaliseLicense(undefined)).toBeUndefined();
    expect(normaliseLicense("   ")).toBeUndefined();
  });
});

describe("normaliseRepositoryUrl", () => {
  it("normalises the many ways npm points at a repo", () => {
    expect(normaliseRepositoryUrl("git+https://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normaliseRepositoryUrl("git://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normaliseRepositoryUrl("github:a/b")).toBe("https://github.com/a/b");
    expect(normaliseRepositoryUrl("a/b")).toBe("https://github.com/a/b");
    expect(normaliseRepositoryUrl("git@github.com:a/b.git")).toBe("https://github.com/a/b");
    expect(normaliseRepositoryUrl({ url: "https://gitlab.com/a/b" })).toBe("https://gitlab.com/a/b");
  });

  it("rejects anything that is not resolvable to an http URL", () => {
    expect(normaliseRepositoryUrl(undefined)).toBeUndefined();
    expect(normaliseRepositoryUrl("")).toBeUndefined();
    expect(normaliseRepositoryUrl({})).toBeUndefined();
  });
});

describe("isValidNpmName", () => {
  it("accepts real names including scopes", () => {
    expect(isValidNpmName("react")).toBe(true);
    expect(isValidNpmName("@babel/core")).toBe(true);
    expect(isValidNpmName("lodash.merge")).toBe(true);
  });

  it("rejects names npm would not accept", () => {
    expect(isValidNpmName("")).toBe(false);
    expect(isValidNpmName("UPPERCASE")).toBe(false);
    expect(isValidNpmName("has space")).toBe(false);
    expect(isValidNpmName("a".repeat(300))).toBe(false);
  });
});

describe("normalisePypiName", () => {
  it("applies PEP 503 normalisation", () => {
    expect(normalisePypiName("Flask_SQLAlchemy")).toBe("flask-sqlalchemy");
    expect(normalisePypiName("zope.interface")).toBe("zope-interface");
    expect(normalisePypiName("  Requests  ")).toBe("requests");
  });
});

describe("normalisePypiResponse", () => {
  const base = {
    info: {
      name: "Demo_Pkg",
      version: "2.0.0",
      summary: "A demo",
      license: "MIT",
      classifiers: ["Development Status :: 5 - Production/Stable"],
      yanked: false,
      project_urls: { Source: "https://github.com/a/b" },
    },
    releases: {
      "1.0.0": [{ upload_time_iso_8601: "2020-01-01T00:00:00.000Z" }],
      "2.0.0": [
        { upload_time_iso_8601: "2023-06-02T00:00:00.000Z" },
        { upload_time_iso_8601: "2023-06-01T00:00:00.000Z" },
      ],
    },
  };

  it("normalises the name and pulls out the scoring fields", () => {
    const pkg = normalisePypiResponse(base);
    expect(pkg.name).toBe("demo-pkg");
    expect(pkg.latestVersion).toBe("2.0.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repositoryUrl).toBe("https://github.com/a/b");
    expect(pkg.developmentStatus).toBe("Development Status :: 5 - Production/Stable");
  });

  it("dates a release by its earliest file upload", () => {
    const pkg = normalisePypiResponse(base);
    expect(pkg.releaseDates).toEqual([
      "2020-01-01T00:00:00.000Z",
      "2023-06-01T00:00:00.000Z",
    ]);
    expect(pkg.lastPublishAt).toBe("2023-06-01T00:00:00.000Z");
  });

  it("leaves bus factor unscored, because PyPI does not publish maintainers", () => {
    expect(normalisePypiResponse(base).maintainerCount).toBeUndefined();
  });

  it("treats a yanked latest release as deprecated", () => {
    const pkg = normalisePypiResponse({
      ...base,
      info: { ...base.info, yanked: true, yanked_reason: "broken build" },
    });
    expect(pkg.deprecated).toBe(true);
    expect(pkg.deprecationNote).toBe("broken build");
  });

  it("ignores a full license text pasted into the license field", () => {
    const pkg = normalisePypiResponse({
      ...base,
      info: { ...base.info, license: "Permission is hereby granted, free of charge, ".repeat(10) },
    });
    expect(pkg.license).toBeUndefined();
  });

  it("prefers license_expression when both are present", () => {
    const pkg = normalisePypiResponse({
      ...base,
      info: { ...base.info, license: "MIT-ish", license_expression: "MIT" },
    });
    expect(pkg.license).toBe("MIT");
  });
});

describe("pickPypiRepository", () => {
  it("prefers an explicit source link", () => {
    expect(pickPypiRepository({ Homepage: "https://x.dev", Source: "https://github.com/a/b" })).toBe(
      "https://github.com/a/b",
    );
    expect(pickPypiRepository({ Repository: "https://gitlab.com/a/b" })).toBe("https://gitlab.com/a/b");
  });

  it("falls back to any code-host URL, then to the homepage", () => {
    expect(pickPypiRepository({ Docs: "https://github.com/a/b" })).toBe("https://github.com/a/b");
    expect(pickPypiRepository(null, "https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(pickPypiRepository(null, "https://example.com")).toBeUndefined();
    expect(pickPypiRepository(undefined)).toBeUndefined();
  });
});

describe("pickDevelopmentStatus", () => {
  it("finds the trove classifier among others", () => {
    expect(
      pickDevelopmentStatus(["Programming Language :: Python", "Development Status :: 7 - Inactive"]),
    ).toBe("Development Status :: 7 - Inactive");
    expect(pickDevelopmentStatus(undefined)).toBeUndefined();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });
});
