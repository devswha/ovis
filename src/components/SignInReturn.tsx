import { useEffect, useState } from "react";

import { carriesReturn, handOverReturn } from "../lib/account/ownWindow.ts";
import { useT } from "../lib/i18n.ts";

/** The page the provider's return lands on in this PC's own window (lib/account/ownWindow.ts): it only hands the return over. */
export function SignInReturn({ params }: { readonly params: string }) {
  const t = useT();
  const [taken, setTaken] = useState(false);
  useEffect(() => handOverReturn(params, () => {
    setTaken(true);
    window.close();
  }), [params]);
  return (
    <main className="app-crash">
      <div className="app-crash-card" role="status">
        <p>{!carriesReturn(params) ? t("Nothing to finish here. Close this tab and go back to Ovis.") : taken ? t("Signed in. Close this tab and go back to Ovis.") : t("Finishing the sign-in in the Ovis tab that started it…")}</p>
      </div>
    </main>
  );
}
