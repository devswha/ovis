import { describe, expect, it } from "bun:test";
import { PlanError } from "./constants.ts";
import { edgeCaddyfile, LOOPBACK, portsFrom, PUBLISH_ARGS, publishRefusal, upOptions } from "./services.ts";

describe("the services' interlock", () => {
  const testPorts = portsFrom("37542,37543,37544,37549");

  it("refuses the published ports to an account service that signs in whoever asks", () => {
    expect(publishRefusal(LOOPBACK, "fake", [])).toContain("27542, 27543, 27544");
    expect(publishRefusal(LOOPBACK, "real", [])).not.toBeNull();
    expect(publishRefusal(LOOPBACK, "real", ["--var", "people"])).not.toBeNull();
    expect(publishRefusal({ ...testPorts, kit: 17541 }, "fake", [])).toContain("17541");
  });

  it("keeps the fake off the published ports, also with a people file", () => {
    expect(publishRefusal(LOOPBACK, "fake", [], "/state/people")).toContain("27542, 27543, 27544");
    expect(publishRefusal(LOOPBACK, "fake", ["--people"], "/state/people")).not.toBeNull();
    expect(publishRefusal(testPorts, "fake", [], "/state/people")).toBeNull();
  });

  it("lets the published ports go to the real code asking a person (a people file, or its own --people), and anything onto test ports", () => {
    expect(publishRefusal(LOOPBACK, "real", [], "/state/people")).toBeNull();
    expect(publishRefusal(LOOPBACK, "real", ["--people"])).toBeNull();
    expect(publishRefusal(testPorts, "fake", [])).toBeNull();
  });

  it("lets the documented argument list for the published ports through services up's own option parser", () => {
    const documented = upOptions([...PUBLISH_ARGS.slice(0, 3), "/state/people", "--account-repo", "/checkout/account"]);
    expect([documented.account, documented.people, documented.accountArgs]).toEqual(["real", "/state/people", []]);
    expect(publishRefusal(LOOPBACK, "real", documented.accountArgs, documented.people ?? null)).toBeNull();
    expect(publishRefusal(LOOPBACK, "fake", [])).toContain(PUBLISH_ARGS.join(" "));
    expect(upOptions(["--account", "real", "--account-arg=--people", "--account-repo", "/x"]).accountArgs).toEqual(["--people"]);
    expect(() => upOptions(["--people"])).toThrow();
    expect(upOptions([]).accountArgs).toEqual([]);
  });

  it("reads four different ports", () => {
    expect(testPorts).toEqual({ account: 37542, relay: 37543, kit: 37544, control: 37549 });
    for (const bad of ["1,2,3,4", "37542,37542,37543,37544", "37542,37543,37544", "a,b,c,d"]) expect(() => portsFrom(bad)).toThrow(PlanError);
  });

  it("keeps the test sign-in route off the edge", () => {
    expect(edgeCaddyfile("10.243.1.12", "10.243.1.11", "s3cr3t")).toContain(":8542 {\n\t@test path /v1/test /v1/test/*\n\trespond @test 404\n");
  });

  it("lets only a request with the secret reach the control API", () => {
    expect(edgeCaddyfile("10.243.1.12", "10.243.1.11", "s3cr3t")).toContain(":8549 {\n\t@key header X-World-Control s3cr3t\n\thandle @key {\n\t\treverse_proxy 10.243.1.12:9090\n\t}\n\thandle {\n\t\trespond 401\n\t}\n}\n");
  });
});
