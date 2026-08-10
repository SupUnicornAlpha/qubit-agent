import { describe, expect, test } from "bun:test";
import { buildContainerPythonArgs } from "../container-python-sandbox";

const policy = {
  mode: "container" as const,
  image: "python:3.12-slim",
  packages: ["requests==2.32.3"],
  wheelhouse: "research-2026-08",
  memoryMiB: 768,
  cpuCount: 1.5,
  pidsLimit: 48,
  tmpfsMiB: 192,
};

describe("container Python sandbox command", () => {
  test("uses an isolated, resource-bounded Docker invocation", () => {
    const args = buildContainerPythonArgs({
      policy,
      containerName: "qubit-py-test",
      wheelhousePath: "/tmp/qubit-wheels",
    });
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("--memory");
    expect(args).toContain("--cpus");
    expect(args).toContain("--user");
    expect(args[args.indexOf("--user") + 1]).toBe("65534:65534");
    expect(args.some((x) => x.includes("dst=/opt/wheels,readonly"))).toBe(true);
  });

  test("does not mount a wheelhouse unless one was explicitly resolved", () => {
    const args = buildContainerPythonArgs({ policy, containerName: "qubit-py-test" });
    expect(args.some((x) => x.includes("/opt/wheels"))).toBe(false);
  });
});
