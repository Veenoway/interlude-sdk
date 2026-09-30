import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listFiles, nameFromDir, NAME_TOKEN, scaffold, ScaffoldError, templateDir, validateName } from "../src/scaffold.js";
import { bin, packageRoot, scratch } from "./helpers.js";

const EXPECTED = [
  ".gitignore",
  ".nvmrc",
  "README.md",
  "contracts/foundry.toml",
  "contracts/interlude.toml",
  "contracts/package.json",
  "contracts/remappings.txt",
  "contracts/src/Clicker.sol",
  "contracts/src/ClickerInterludeSurface.sol",
  "contracts/test/Clicker.t.sol",
  "web/.env.example",
  "web/app/globals.css",
  "web/app/layout.tsx",
  "web/app/page.tsx",
  "web/components/clicker-app.tsx",
  "web/lib/abi.ts",
  "web/lib/chain.ts",
  "web/lib/interlude.ts",
  "web/lib/wallet.ts",
  "web/next.config.ts",
  "web/package.json",
  "web/tsconfig.json",
];

let cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function tmp() {
  const s = scratch();
  cleanups.push(s.cleanup);
  return s.dir;
}

function read(dir, path) {
  return readFileSync(join(dir, path), "utf8");
}

describe("scaffold", () => {
  it("writes every template file, with .gitignore restored from _gitignore", () => {
    const dir = join(tmp(), "my-app");
    const result = scaffold({ dir });

    expect(result.dir).toBe(dir);
    expect([...result.files].sort()).toEqual([...EXPECTED].sort());
    for (const file of EXPECTED) expect(existsSync(join(dir, file)), file).toBe(true);
    expect(existsSync(join(dir, "_gitignore"))).toBe(false);
    expect(read(dir, ".gitignore")).toMatch(/node_modules\//);
    expect(read(dir, ".gitignore")).toMatch(/contracts\/lib\/interlude\//);
  });

  it("substitutes the name everywhere and leaves no token behind", () => {
    const dir = join(tmp(), "anything");
    const { name, files } = scaffold({ dir, name: "tap-race" });

    expect(name).toBe("tap-race");
    expect(JSON.parse(read(dir, "contracts/package.json")).name).toBe("tap-race-contracts");
    expect(JSON.parse(read(dir, "web/package.json")).name).toBe("tap-race-web");
    expect(read(dir, "README.md").split("\n")[0]).toBe("# tap-race");
    expect(read(dir, "web/app/layout.tsx")).toContain('title: "tap-race"');
    for (const file of files) expect(read(dir, file), file).not.toContain(NAME_TOKEN);
  });

  it("names the project after its directory when --name is not given", () => {
    const dir = join(tmp(), "My Game (v2)");
    expect(scaffold({ dir }).name).toBe("my-game-v2");
    expect(JSON.parse(read(dir, "web/package.json")).name).toBe("my-game-v2-web");
  });

  it("works in a path with spaces and accents, which is where npx and users put things", () => {
    const dir = join(tmp(), "Projets é", "Mon Clicker");
    const { files } = scaffold({ dir });

    expect(dir).toMatch(/ /);
    expect(files).toHaveLength(EXPECTED.length);
    expect(read(dir, "contracts/src/Clicker.sol")).toContain("contract Clicker is");
    expect(read(dir, "contracts/package.json")).toContain('"name": "mon-clicker-contracts"');
  });

  it("refuses a non-empty directory and writes nothing into it", () => {
    const dir = tmp();
    writeFileSync(join(dir, "foundry.toml"), "# mine\n");

    expect(() => scaffold({ dir })).toThrow(ScaffoldError);
    expect(() => scaffold({ dir })).toThrow(/not empty \(foundry\.toml\)/);
    expect(readdirSync(dir)).toEqual(["foundry.toml"]);
    expect(read(dir, "foundry.toml")).toBe("# mine\n");
  });

  it("accepts an empty directory, and one holding only a fresh git init", () => {
    const empty = join(tmp(), "empty");
    mkdirSync(empty);
    expect(scaffold({ dir: empty }).files).toHaveLength(EXPECTED.length);

    const gitOnly = join(tmp(), "git-only");
    mkdirSync(join(gitOnly, ".git"), { recursive: true });
    expect(scaffold({ dir: gitOnly }).files).toHaveLength(EXPECTED.length);
  });

  it("refuses a path that is a file", () => {
    const file = join(tmp(), "taken");
    writeFileSync(file, "x");
    expect(() => scaffold({ dir: file })).toThrow(/is a file/);
  });

  it("refuses a name npm would refuse, before writing anything", () => {
    const dir = join(tmp(), "fresh");
    expect(() => scaffold({ dir, name: "My App" })).toThrow(/cannot be the project name/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("names", () => {
  it("validates like npm", () => {
    expect(validateName("my-app")).toBeNull();
    expect(validateName("a.b_c~d")).toBeNull();
    expect(validateName("")).toMatch(/empty/);
    expect(validateName("MyApp")).toMatch(/lowercase/);
    expect(validateName(".hidden")).toMatch(/start with/);
    expect(validateName("_private")).toMatch(/start with/);
    expect(validateName("has space")).toMatch(/lowercase letters/);
    expect(validateName("x".repeat(201))).toMatch(/longer/);
  });

  it("derives a usable name from any directory", () => {
    expect(nameFromDir("/tmp/Café Clicker")).toBe("cafe-clicker");
    expect(nameFromDir("/tmp/__init__")).toBe("init");
    expect(nameFromDir("/tmp/???")).toBe("interlude-app");
  });
});

describe("the template as published", () => {
  it("ships nothing npm would drop or rename, so the tarball is the template", () => {
    const files = listFiles(templateDir()).map((file) => file.split(/[\\/]/).pop());
    for (const dropped of [".gitignore", ".npmrc", "package-lock.json", "node_modules"]) {
      expect(files).not.toContain(dropped);
    }
  });

  it("is what `npm pack` would publish", () => {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const paths = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
    for (const file of listFiles(templateDir())) {
      expect(paths, file).toContain(`template/${file.split("\\").join("/")}`);
    }
    expect(paths).toContain("bin/create-interlude-app.js");
    expect(paths.some((path) => path.startsWith("test/"))).toBe(false);
  });
});

describe("the bin", () => {
  function run(args, cwd) {
    return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
  }

  it("scaffolds from a cwd with a space and prints the next commands, quoted", () => {
    const cwd = tmp();
    const out = run(["Space Game", "--name", "space-game"], cwd);

    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("Created space-game");
    expect(out.stdout).toContain("cd 'Space Game'/contracts");
    expect(out.stdout).toContain("npx interlude ship --owner <your address> --out ../web/.env.local");
    expect(existsSync(join(cwd, "Space Game", "contracts", "src", "Clicker.sol"))).toBe(true);
  });

  it("runs when the package itself is installed under a path with a space", () => {
    // Where npx puts it: ~/.npm/_npx/<hash>/node_modules, and home is "/Users/John Doe". The
    // template has to be found by a file path, not a URL path with %20 in it.
    const installed = join(tmp(), "John Doé", "node_modules", "create-interlude-app");
    for (const part of ["bin", "src", "template", "package.json"]) {
      cpSync(join(packageRoot, part), join(installed, part), { recursive: true });
    }
    const cwd = tmp();
    const out = spawnSync(
      process.execPath,
      [join(installed, "bin", "create-interlude-app.js"), "game"],
      { cwd, encoding: "utf8" },
    );

    expect(out.status, out.stderr).toBe(0);
    expect(existsSync(join(cwd, "game", "contracts", "src", "Clicker.sol"))).toBe(true);
  });

  it("exits 1 with a sentence on a non-empty directory", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "taken"));
    writeFileSync(join(cwd, "taken", "README.md"), "mine");
    const out = run(["taken"], cwd);

    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/is not empty \(README\.md\)/);
    expect(readdirSync(join(cwd, "taken"))).toEqual(["README.md"]);
  });

  it("exits 1 without a directory, and on a bad option", () => {
    const cwd = tmp();
    expect(run([], cwd).status).toBe(1);
    expect(run(["x", "--nmae", "y"], cwd).stderr).toMatch(/unknown option --nmae/);
    expect(run(["x", "--name"], cwd).stderr).toMatch(/--name needs a value/);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("answers --help and --version", () => {
    const cwd = tmp();
    expect(run(["--help"], cwd).stdout).toContain("npx create-interlude-app <dir>");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(run(["--version"], cwd).stdout.trim()).toBe(pkg.version);
  });
});
