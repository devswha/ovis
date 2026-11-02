import { describe, expect, it } from "bun:test";
import { moveQueryToFragment, pageAddress, pageSearch } from "./pageQuery.ts";

describe("the page's query", () => {
  it("is the address's query on a PC's own server, fragment kept beside it", () => {
    expect(pageSearch({ search: "?file=%2Fa.md", hash: "#x" }, null)).toBe("?file=%2Fa.md");
    expect(pageAddress("/", "?file=%2Fa.md", "#x", null)).toBe("/?file=%2Fa.md#x");
    expect(pageAddress("/", "", "", null)).toBe("/");
  });

  it("rides in the fragment in the hosted shell, so no request to its host carries it", () => {
    const scope = `/s/${"ab".repeat(16)}/`;
    const address = pageAddress(scope, "?read=%2Fhome%2Fme%2Fplan.md&machine=local", "#ignored", "relay");
    expect(address).toBe(`${scope}#read=%2Fhome%2Fme%2Fplan.md&machine=local`);
    const url = new URL(address, "https://app.example");
    expect(url.pathname + url.search).toBe(scope);
    expect(pageSearch({ search: "", hash: url.hash }, "relay")).toBe("?read=%2Fhome%2Fme%2Fplan.md&machine=local");
    expect(pageAddress(scope, "", "", "relay")).toBe(scope);
    expect(pageAddress(scope, "?", "", "relay")).toBe(scope);
  });

  it("still reads a shell address from before the move, its query over any other fragment", () => {
    expect(pageSearch({ search: "?file=%2Fa.md", hash: "" }, "relay")).toBe("?file=%2Fa.md");
    expect(pageSearch({ search: "?read=%2Fa.md", hash: "#auth=x" }, "relay")).toBe("?read=%2Fa.md");
  });

  it("never takes a pasted pairing offer for the page's state", () => {
    expect(pageSearch({ search: "", hash: "#offer=eyJ2IjoxfQ" }, "relay")).toBe("");
  });

  it("moves an older entry's query into the fragment, keeping the entry's state", () => {
    const replaced: [unknown, string][] = [];
    const page = (search: string) => ({ location: { pathname: "/s/x/", search }, history: { state: { nav: 1 }, replaceState: (data: unknown, _: string, url: string) => { replaced.push([data, url]); } } });
    expect(moveQueryToFragment(page("?pane=w1%3Ap1&file=%2Fa.md"))).toBe(true);
    expect(moveQueryToFragment(page(""))).toBe(false);
    expect(moveQueryToFragment(page("?"))).toBe(false);
    expect(replaced).toEqual([[{ nav: 1 }, "/s/x/#pane=w1%3Ap1&file=%2Fa.md"]]);
  });
});
