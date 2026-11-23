import { Card } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { GitHubConnect } from "./GitHubConnect";
import { GitHubMark } from "./GitHubMark";

/**
 * Settings › General: the linked GitHub account. Disconnecting only forgets the
 * token locally; revoking the grant happens on GitHub, which the card says.
 */
export function GitHubCard() {
  const t = useT();
  return (
    <Card className="mb-4 flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2.5">
        <GitHubMark className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">GitHub</h2>
          <p className="text-[11px] text-text-3">
            {t("The account whose repositories Projects can clone. To revoke access for good, remove Assay under GitHub › Settings › Applications.")}
          </p>
        </div>
      </div>
      <GitHubConnect />
    </Card>
  );
}
