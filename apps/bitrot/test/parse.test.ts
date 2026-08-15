import { describe, expect, it } from "vitest";
import {
  detectManifestKind,
  exactVersionFrom,
  ManifestParseError,
  parseManifest,
  parsePackageJson,
  parsePackageLock,
  parseRequirementsTxt,
  unwrapNpmAlias,
} from "../src/lib/parse";

const byName = (deps: { name: string }[]) => deps.map((d) => d.name).sort();

describe("parsePackageJson", () => {
  it("collects every dependency section and records where each came from", () => {
    const manifest = parsePackageJson(
      JSON.stringify({
        dependencies: { react: "^18.2.0" },
        devDependencies: { vitest: "^2.0.0" },
        optionalDependencies: { fsevents: "^2.3.0" },
        peerDependencies: { typescript: ">=5" },
      }),
    );
    expect(byName(manifest.dependencies)).toEqual(["fsevents", "react", "typescript", "vitest"]);
    expect(manifest.dependencies.find((d) => d.name === "vitest")?.section).toBe("devDependencies");
    expect(manifest.ecosystem).toBe("npm");
  });

  it("keeps the range exactly as written", () => {
    const manifest = parsePackageJson(JSON.stringify({ dependencies: { lodash: "^4.17.21" } }));
    expect(manifest.dependencies[0]?.range).toBe("^4.17.21");
    expect(manifest.dependencies[0]?.resolvedVersion).toBeUndefined();
  });

  it("skips specs that do not name a registry package, and says so", () => {
    const manifest = parsePackageJson(
      JSON.stringify({
        dependencies: {
          react: "^18.2.0",
          "my-lib": "workspace:*",
          "local-thing": "file:../local",
          forked: "git+https://github.com/acme/forked.git",
        },
      }),
    );
    expect(byName(manifest.dependencies)).toEqual(["react"]);
    expect(manifest.warnings).toHaveLength(3);
    expect(manifest.warnings.join(" ")).toContain("workspace:*");
  });

  it("resolves an npm: alias to the package actually installed", () => {
    const manifest = parsePackageJson(
      JSON.stringify({ dependencies: { "my-lodash": "npm:lodash@^4.17.21" } }),
    );
    expect(manifest.dependencies[0]?.name).toBe("lodash");
    expect(manifest.dependencies[0]?.range).toBe("^4.17.21");
  });

  it("deduplicates a package declared in two sections", () => {
    const manifest = parsePackageJson(
      JSON.stringify({ dependencies: { react: "^18.0.0" }, peerDependencies: { react: "*" } }),
    );
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.dependencies[0]?.section).toBe("dependencies");
  });

  it("rejects invalid JSON and empty manifests with a usable message", () => {
    expect(() => parsePackageJson("{not json")).toThrow(ManifestParseError);
    expect(() => parsePackageJson(JSON.stringify({ name: "x" }))).toThrow(/No dependencies/);
  });
});

describe("parsePackageLock", () => {
  it("reads exact versions out of a v3 lockfile, including the transitive tree", () => {
    const manifest = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "root" },
          "node_modules/react": { version: "18.2.0", resolved: "https://registry.npmjs.org/react/-/react-18.2.0.tgz" },
          "node_modules/@babel/core": { version: "7.24.0", resolved: "https://registry.npmjs.org/x.tgz" },
          "node_modules/react/node_modules/loose-envify": { version: "1.4.0", resolved: "https://registry.npmjs.org/y.tgz" },
        },
      }),
    );
    expect(byName(manifest.dependencies)).toEqual(["@babel/core", "loose-envify", "react"]);
    expect(manifest.dependencies.find((d) => d.name === "react")?.resolvedVersion).toBe("18.2.0");
    expect(manifest.kind).toBe("package-lock.json");
  });

  it("ignores workspace symlinks, which have no registry record", () => {
    const manifest = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/react": { version: "18.2.0" },
          "node_modules/@acme/internal": { link: true, resolved: "apps/internal" },
        },
      }),
    );
    expect(byName(manifest.dependencies)).toEqual(["react"]);
  });

  it("marks dev-only packages", () => {
    const manifest = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/vitest": { version: "2.0.0", dev: true } },
      }),
    );
    expect(manifest.dependencies[0]?.section).toBe("devDependencies");
  });

  it("walks the nested tree of a v1 lockfile", () => {
    const manifest = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          react: { version: "16.8.0", dependencies: { "loose-envify": { version: "1.4.0" } } },
        },
      }),
    );
    expect(byName(manifest.dependencies)).toEqual(["loose-envify", "react"]);
  });

  it("caps very large lockfiles and reports the truncation", () => {
    const packages: Record<string, unknown> = { "": {} };
    for (let i = 0; i < 260; i++) packages[`node_modules/pkg-${i}`] = { version: "1.0.0" };
    const manifest = parsePackageLock(JSON.stringify({ lockfileVersion: 3, packages }));
    expect(manifest.dependencies).toHaveLength(200);
    expect(manifest.warnings.join(" ")).toMatch(/260 packages/);
  });
});

describe("parseRequirementsTxt", () => {
  it("parses pins, ranges, extras and comments", () => {
    const manifest = parseRequirementsTxt(
      [
        "# core deps",
        "requests==2.31.0",
        "flask>=2.0,<3.0",
        "celery[redis]==5.3.1",
        "",
        "django~=4.2  # web framework",
      ].join("\n"),
    );
    expect(byName(manifest.dependencies)).toEqual(["celery", "django", "flask", "requests"]);
    expect(manifest.dependencies.find((d) => d.name === "requests")?.resolvedVersion).toBe("2.31.0");
    expect(manifest.ecosystem).toBe("pypi");
  });

  it("treats only == as pinning an exact version", () => {
    expect(exactVersionFrom("==1.2.3")).toBe("1.2.3");
    expect(exactVersionFrom("===1.2.3")).toBe("1.2.3");
    expect(exactVersionFrom(">=1.2.3")).toBeUndefined();
    expect(exactVersionFrom(">=1.0,<2.0")).toBeUndefined();
    expect(exactVersionFrom("")).toBeUndefined();
  });

  it("normalises names per PEP 503 so casing and separators collapse", () => {
    const manifest = parseRequirementsTxt("Flask_SQLAlchemy==3.0.0\nflask-sqlalchemy==3.0.0");
    expect(manifest.dependencies).toHaveLength(1);
    expect(manifest.dependencies[0]?.name).toBe("flask-sqlalchemy");
  });

  it("drops environment markers but keeps the requirement", () => {
    const manifest = parseRequirementsTxt('tomli==2.0.1 ; python_version < "3.11"');
    expect(manifest.dependencies[0]?.name).toBe("tomli");
    expect(manifest.dependencies[0]?.resolvedVersion).toBe("2.0.1");
  });

  it("reports the directives it cannot follow instead of silently dropping them", () => {
    const manifest = parseRequirementsTxt(
      ["requests==2.31.0", "-r other-requirements.txt", "-e .", "--index-url https://example.com"].join("\n"),
    );
    expect(byName(manifest.dependencies)).toEqual(["requests"]);
    expect(manifest.warnings.join(" ")).toContain("other-requirements.txt");
    expect(manifest.warnings.join(" ")).toMatch(/editable/);
  });

  it("skips direct URL requirements, which have no PyPI release", () => {
    const manifest = parseRequirementsTxt(
      ["requests==2.31.0", "mylib @ https://example.com/mylib.whl"].join("\n"),
    );
    expect(byName(manifest.dependencies)).toEqual(["requests"]);
    expect(manifest.warnings.join(" ")).toMatch(/direct URL/);
  });

  it("joins backslash continuations", () => {
    const manifest = parseRequirementsTxt("requests==\\\n2.31.0");
    expect(manifest.dependencies[0]?.resolvedVersion).toBe("2.31.0");
  });

  it("rejects a comment-only file", () => {
    expect(() => parseRequirementsTxt("# nothing here\n\n")).toThrow(ManifestParseError);
  });
});

describe("detectManifestKind", () => {
  it("tells a lockfile from a package.json by content, not filename", () => {
    expect(detectManifestKind('{"lockfileVersion": 3, "packages": {}}', "package.json")).toBe(
      "package-lock.json",
    );
    expect(detectManifestKind('{"dependencies": {}}', "whatever.txt")).toBe("package.json");
  });

  it("falls back to requirements.txt for non-JSON input", () => {
    expect(detectManifestKind("requests==2.31.0")).toBe("requirements.txt");
  });
});

describe("parseManifest", () => {
  it("routes each format to its parser", () => {
    expect(parseManifest('{"dependencies":{"react":"^18.0.0"}}').ecosystem).toBe("npm");
    expect(parseManifest("requests==2.31.0").ecosystem).toBe("pypi");
  });

  it("rejects empty input", () => {
    expect(() => parseManifest("   ")).toThrow(ManifestParseError);
  });
});

describe("unwrapNpmAlias", () => {
  it("handles scoped and unscoped aliases", () => {
    expect(unwrapNpmAlias("npm:lodash@^4.0.0")).toEqual({ name: "lodash", range: "^4.0.0" });
    expect(unwrapNpmAlias("npm:@scope/pkg@1.0.0")).toEqual({ name: "@scope/pkg", range: "1.0.0" });
    expect(unwrapNpmAlias("^4.0.0")).toBeNull();
  });
});
