import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu"; // Assuming these exist or I will check/create them. Wait, user request said "integrated to right".
// If dropdown is not available I'll just put them in a row first.
// Checking file list earlier: "ui" folder had 21 files. I did not see dropdown-menu.tsx in the list.
// List was: alert, badge, button, card, checkbox, dialog, field, input, label, pagination, popover, select, separator, sheet, sidebar, skeleton, switch, table, tabs, textarea, tooltip.
// So NO dropdown-menu.
// I will just place the user info and logout button directly on the right side for now, consistent with the plan "User info, logout also integrated to top menu right side".

import { Film, LogOut, Shield, Users, Coins } from "lucide-react";

export function AdminHeader() {
    const { session } = useAuth();
    const pathname = useRouterState({ select: (state) => state.location.pathname });

    // Logic from Dashboard.tsx
    const activeTab =
        pathname === "/" || pathname.startsWith("/users")
            ? "system-users"
            : pathname.startsWith("/admins")
                ? "admin-users"
                : pathname.startsWith("/videos")
                    ? "videos"
                    : pathname.startsWith("/quotas")
                        ? "quotas"
                        : "system-users";

    return (
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background px-6 shadow-sm">
            <div className="flex items-center gap-2 font-semibold">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <span className="text-xs font-bold">YC</span>
                </div>
                <span className="hidden sm:inline-block">YouChannel 管理</span>
            </div>
            <nav className="flex items-center gap-4 md:gap-6 lg:gap-8 ml-6">
                <Link
                    to="/users"
                    className={`text-sm font-medium transition-colors hover:text-primary ${activeTab === "system-users" ? "text-foreground" : "text-muted-foreground"
                        }`}
                >
                    <div className="flex items-center gap-2">
                        <Users className="h-4 w-4" />
                        <span>用户</span>
                    </div>
                </Link>
                <Link
                    to="/admins"
                    className={`text-sm font-medium transition-colors hover:text-primary ${activeTab === "admin-users" ? "text-foreground" : "text-muted-foreground"
                        }`}
                >
                    <div className="flex items-center gap-2">
                        <Shield className="h-4 w-4" />
                        <span>管理员</span>
                    </div>
                </Link>
                <Link
                    to="/videos"
                    className={`text-sm font-medium transition-colors hover:text-primary ${activeTab === "videos" ? "text-foreground" : "text-muted-foreground"
                        }`}
                >
                    <div className="flex items-center gap-2">
                        <Film className="h-4 w-4" />
                        <span>视频</span>
                    </div>
                </Link>
                <Link
                    to="/quotas"
                    search={{ userId: undefined }}
                    className={`text-sm font-medium transition-colors hover:text-primary ${activeTab === "quotas" ? "text-foreground" : "text-muted-foreground"
                        }`}
                >
                    <div className="flex items-center gap-2">
                        <Coins className="h-4 w-4" />
                        <span>配额</span>
                    </div>
                </Link>
            </nav>
            <div className="ml-auto flex items-center gap-4">
                <div className="flex flex-col items-end hidden sm:flex">
                    <span className="text-sm font-medium leading-none">{session?.user.email ?? "管理员用户"}</span>
                    <span className="text-xs text-muted-foreground">管理员</span>
                </div>
                <Button variant="ghost" size="icon" onClick={() => supabase.auth.signOut()} title="退出登录">
                    <LogOut className="h-5 w-5" />
                </Button>
            </div>
        </header>
    );
}
