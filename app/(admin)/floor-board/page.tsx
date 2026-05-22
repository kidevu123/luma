// app/(admin)/floor-board/page.tsx
// TEMP DEBUG: stripped to isolate Date serialization error
import { requireSession } from "@/lib/auth-guards";

export const dynamic = "force-dynamic";

export default async function FloorBoardPage() {
  console.log("[floor-board] PAGE START");
  const user = await requireSession();
  console.log("[floor-board] SESSION OK:", user.id);
  return (
    <div className="p-8 text-white">
      <h1 className="text-2xl font-bold">Floor Board — Debug Mode</h1>
      <p className="text-slate-400 mt-2">Page rendered OK. User: {user.email}</p>
    </div>
  );
}
