import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth-guards";
import { Sidebar } from "@/components/admin/sidebar";
import { Topbar } from "@/components/admin/topbar";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireSession();
  return (
    <div className="min-h-dvh flex bg-page">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar email={user.email} role={user.role} />
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-screen-2xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
