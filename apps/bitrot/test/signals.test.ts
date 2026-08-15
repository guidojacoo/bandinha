import { describe, expect, it } from "vitest";
import {
  busFactorSignal,
  cadenceSignal,
  coerceVersion,
  deprecationSignal,
  driftSignal,
  formatDuration,
  immaturitySignal,
  licenseSignal,
  provenanceSignal,
  stalenessSignal,
} from "../src/lib/rot/signals";
import { NOW, daysAgo, pkg } from "./fixtures";

describe("stalenessSignal", () => {
  it("treats a release inside six months as no rot at all", () => {
    expect(stalenessSignal(pkg({ lastPublishAt: daysAgo(179) }), NOW).value).toBe(0);
  });

  it("ramps between six months and a year", () => {
    const v = stalenessSignal(pkg({ lastPublishAt: daysAgo(272) }), NOW).value!;
    expect(v).toBeGreaterThan(0.1);
    expect(v).toBeLessThan(0.25);
  });

  it("increases monotonically with age", () => {
    const ages = [100, 300, 500, 900, 1500, 3000];
    const values = ages.map((d) => stalenessSignal(pkg({ lastPublishAt: daysAgo(d) }), NOW).value!);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it("saturates at 1 past four years", () => {
    expect(stalenessSignal(pkg({ lastPublishAt: daysAgo(1461) }), NOW).value).toBe(1);
    expect(stalenessSignal(pkg({ lastPublishAt: daysAgo(9000) }), NOW).value).toBe(1);
  });

  it("is unscored when the registry reported no release date", () => {
    expect(stalenessSignal(pkg({ lastPublishAt: undefined }), NOW).value).toBeNull();
  });

  it("does not go negative when a release date is in the future", () => {
    const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    expect(stalenessSignal(pkg({ lastPublishAt: future }), NOW).value).toBe(0);
  });
});

describe("cadenceSignal", () => {
  it("scores nothing when the release rate is holding up", () => {
    const dates = [daysAgo(700), daysAgo(600), daysAgo(300), daysAgo(200), daysAgo(100)];
    expect(cadenceSignal(pkg({ releaseDates: dates }), NOW).value).toBe(0);
  });

  it("maxes out when releases stopped after an active year", () => {
    const dates = [daysAgo(700), daysAgo(600), daysAgo(500), daysAgo(400)];
    expect(cadenceSignal(pkg({ releaseDates: dates }), NOW).value).toBe(1);
  });

  it("reports a partial slowdown proportionally", () => {
    const dates = [
      daysAgo(700), daysAgo(650), daysAgo(600), daysAgo(550), // 4 in prior year
      daysAgo(300), // 1 in the last year
    ];
    expect(cadenceSignal(pkg({ releaseDates: dates }), NOW).value).toBeCloseTo(0.75, 5);
  });

  it("flags a two-year silence without treating it as a fresh stop", () => {
    const dates = [daysAgo(1200), daysAgo(1100)];
    expect(cadenceSignal(pkg({ releaseDates: dates }), NOW).value).toBe(0.85);
  });

  it("does not punish a package that only just started releasing", () => {
    const dates = [daysAgo(60), daysAgo(30), daysAgo(5)];
    expect(cadenceSignal(pkg({ releaseDates: dates }), NOW).value).toBe(0);
  });

  it("is unscored with no release history", () => {
    expect(cadenceSignal(pkg({ releaseDates: [] }), NOW).value).toBeNull();
  });
});

describe("busFactorSignal", () => {
  it("maxes out on a single publisher", () => {
    expect(busFactorSignal(pkg({ maintainerCount: 1 })).value).toBe(1);
  });

  it("decreases as maintainers are added", () => {
    const two = busFactorSignal(pkg({ maintainerCount: 2 })).value!;
    const three = busFactorSignal(pkg({ maintainerCount: 3 })).value!;
    expect(two).toBeGreaterThan(three);
    expect(busFactorSignal(pkg({ maintainerCount: 4 })).value).toBe(0);
  });

  it("is unscored — not zero — when the registry does not publish maintainers", () => {
    const signal = busFactorSignal(pkg({ ecosystem: "pypi", maintainerCount: undefined }));
    expect(signal.value).toBeNull();
    expect(signal.detail).toMatch(/PyPI/);
  });
});

describe("driftSignal", () => {
  it("is clean on the latest version", () => {
    expect(driftSignal("3.2.1", "3.2.1").value).toBe(0);
  });

  it("is mild for a patch or minor gap", () => {
    expect(driftSignal("3.2.1", "3.1.0").value).toBe(0.15);
  });

  it("grows with each major version behind", () => {
    expect(driftSignal("4.0.0", "3.0.0").value).toBe(0.5);
    expect(driftSignal("5.0.0", "3.0.0").value).toBe(0.8);
    expect(driftSignal("9.0.0", "3.0.0").value).toBe(1);
  });

  it("treats a 0.x minor as breaking, because semver says it is", () => {
    expect(driftSignal("0.5.0", "0.4.0").value).toBe(0.5);
    expect(driftSignal("0.9.0", "0.2.0").value).toBe(1);
  });

  it("reads a version out of a caret range", () => {
    expect(driftSignal("5.0.0", "^3.1.0").value).toBe(0.8);
  });

  it("is unscored when the manifest pins nothing comparable", () => {
    expect(driftSignal("3.2.1", "workspace:*").value).toBeNull();
    expect(driftSignal("3.2.1", undefined).value).toBeNull();
    expect(driftSignal(undefined, "1.0.0").value).toBeNull();
  });

  it("never reports negative drift when ahead of the registry", () => {
    expect(driftSignal("3.0.0", "4.0.0").value).toBe(0.15);
  });
});

describe("licenseSignal", () => {
  it("accepts a real SPDX identifier", () => {
    expect(licenseSignal(pkg({ license: "MIT" })).value).toBe(0);
  });

  it("flags missing, unknown and unlicensed alike", () => {
    for (const license of [undefined, "", "UNKNOWN", "unlicensed", "SEE LICENSE"]) {
      expect(licenseSignal(pkg({ license })).value, `license=${license}`).toBe(1);
    }
  });
});

describe("immaturitySignal", () => {
  it("maxes out for a days-old package with almost no releases", () => {
    expect(immaturitySignal(pkg({ firstPublishAt: daysAgo(10), releaseCount: 1 }), NOW).value).toBe(1);
  });

  it("is clean for an established package", () => {
    expect(immaturitySignal(pkg({ firstPublishAt: daysAgo(2000), releaseCount: 50 }), NOW).value).toBe(0);
  });

  it("is unscored without a first-release date", () => {
    expect(immaturitySignal(pkg({ firstPublishAt: undefined }), NOW).value).toBeNull();
  });
});

describe("provenanceSignal", () => {
  it("flags a package with no linked source", () => {
    expect(provenanceSignal(pkg({ repositoryUrl: undefined })).value).toBe(1);
    expect(provenanceSignal(pkg()).value).toBe(0);
  });
});

describe("deprecationSignal", () => {
  it("fires on an npm deprecation and quotes the maintainers", () => {
    const s = deprecationSignal(pkg({ deprecated: true, deprecationNote: "use foo instead" }));
    expect(s.value).toBe(1);
    expect(s.detail).toContain("use foo instead");
  });

  it("fires on PyPI's inactive classifier", () => {
    const s = deprecationSignal(
      pkg({ ecosystem: "pypi", developmentStatus: "Development Status :: 7 - Inactive" }),
    );
    expect(s.value).toBe(1);
  });

  it("does not fire on a merely mature package", () => {
    const s = deprecationSignal(
      pkg({ ecosystem: "pypi", developmentStatus: "Development Status :: 6 - Mature" }),
    );
    expect(s.value).toBe(0);
  });
});

describe("coerceVersion", () => {
  it("parses full, partial and prefixed versions", () => {
    expect(coerceVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(coerceVersion("^4.17")).toEqual({ major: 4, minor: 17, patch: 0 });
    expect(coerceVersion(">=2")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(coerceVersion("v1.0.0-beta.3")).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it("returns null for specs with no version in them", () => {
    expect(coerceVersion("workspace:*")).toBeNull();
    expect(coerceVersion("*")).toBeNull();
    expect(coerceVersion(undefined)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("scales units with the magnitude", () => {
    expect(formatDuration(1)).toBe("1 day");
    expect(formatDuration(45)).toBe("45 days");
    expect(formatDuration(365)).toBe("12 months");
    expect(formatDuration(1000)).toBe("2.7 years");
  });
});
