import { rupees, type BookingsListPart } from "../shared/parts.js";

/** FR-5: the signed-in user's bookings, upcoming and past, as the server listed them. */
export const BookingsList = ({ part }: { part: BookingsListPart }) => (
  <ul className="mt-2 space-y-1 text-sm">
    {part.bookings.map((b) => (
      <li key={b.id} className="rounded border border-neutral-300 bg-white px-2 py-1">
        <span className="font-medium">{b.providerName}</span> · {b.slotLabel} · {rupees(b.price)} ·{" "}
        <span className="text-neutral-500">{b.status}</span>
        <span className="block text-xs text-neutral-400">id {b.id}</span>
      </li>
    ))}
  </ul>
);
