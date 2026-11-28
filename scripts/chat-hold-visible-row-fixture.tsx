import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

declare global {
  interface Window {
    holdQa: { measured: (key: string) => boolean };
  }
}

// Rows far up are 100 px; the ones a chat opens on are 120 px, so the list's estimate for a row it
// has not measured (the average of those it has) is 20 px off, as in the CI run behind #3662.
const rows = Array.from({ length: 200 }, (_, index) => ({ key: `row-${index}`, height: index < 188 ? 100 : 120 }));

function Fixture() {
  const list = useRef<LegendListRef>(null);
  window.holdQa = { measured: (key) => list.current?.getState().sizes.has(key) ?? false };
  return <LegendList
    ref={list}
    style={{ height: 900, overflow: "auto" }}
    className="hold-qa-scroller"
    data={rows}
    keyExtractor={(row) => row.key}
    renderItem={({ item }) => <div data-row={item.key} style={{ height: item.height }}>{item.key}</div>}
    estimatedItemSize={120}
    drawDistance={400}
    recycleItems={false}
    initialScrollAtEnd
    maintainVisibleContentPosition
  />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Hold fixture root missing");
createRoot(root).render(<Fixture />);
