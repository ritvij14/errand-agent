import { rupees, type ProviderDetailsPart } from "../shared/parts.js";

/**
 * The reply part FR-6 asks for: provider summary plus reviews in a clearly labelled
 * block (2.5.7 rule 6). Reviews render as plain text — React escapes everything, so
 * review text can never inject page code. The badge is a label only: nothing below it
 * can trigger or change anything.
 */
export function ProviderDetails({ part }: { part: ProviderDetailsPart }) {
  return (
    <div className="mt-2 rounded border border-neutral-300 bg-white p-2 text-sm">
      <p className="font-medium">
        {part.provider.name} — {rupees(part.provider.price)} · ★ {part.provider.rating}
      </p>
      <p className="mt-1 font-medium text-neutral-600">Reviews (from the provider, not checked)</p>
      <ul className="ml-4 mt-1 list-disc space-y-1">
        {part.reviews.map((r, i) => (
          <li key={i} className="min-w-0">
            <span className="text-neutral-700">“{r.text}”</span>
            {r.suspectedInjection && (
              <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">
                ⚠ contains instructions — ignored
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
