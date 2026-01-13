import { Link, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Film, LogOut, Shield, Users, Coins, ChevronDown, Activity } from "lucide-react";

type NavItem = {
  title: string;
  icon?: React.ElementType;
  to?: string;
  search?: Record<string, unknown>;
  children?: NavItem[];
  activeTab?: string; // Standardize this if possible, or derive from 'to'
  matchPrefix?: string[]; // For checking active state
};

export function AdminHeader() {
  const { session } = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Navigation Data Structure
  const navItems: NavItem[] = [
    {
      title: "用户管理",
      icon: Users, // Using Users as generic icon for the group
      matchPrefix: ["/users", "/admins"],
      children: [
        {
          title: "用户列表",
          to: "/users",
          icon: Users,
          matchPrefix: ["/users"],
        },
        {
          title: "管理员列表",
          to: "/admins",
          icon: Shield,
          matchPrefix: ["/admins"],
        }
      ]
    },
    {
      title: "视频管理",
      to: "/videos",
      icon: Film,
      matchPrefix: ["/videos"],
    },
    {
      title: "配额管理",
      to: "/quotas",
      icon: Coins,
      search: { userId: undefined },
      matchPrefix: ["/quotas"],
    },
    {
      title: "任务监控",
      to: "/jobs",
      icon: Activity,
      matchPrefix: ["/jobs"],
    }
  ];

  const isActive = (item: NavItem) => {
    if (item.matchPrefix) {
      return item.matchPrefix.some(prefix => pathname === prefix || pathname.startsWith(prefix + "/"));
    }
    return false;
  };

  const renderNavItem = (item: NavItem) => {
    const active = isActive(item);
    const styleClass = `text-sm font-medium transition-colors hover:text-primary ${active ? "text-foreground" : "text-muted-foreground"
      }`;

    if (item.children) {
      return (
        <DropdownMenu key={item.title}>
          <DropdownMenuTrigger className={`flex items-center gap-2 outline-none ${styleClass}`}>
            {item.icon && <item.icon className="h-4 w-4" />}
            <span>{item.title}</span>
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {item.children.map(child => (
              <DropdownMenuItem key={child.title} asChild>
                <Link
                  to={child.to!}
                  search={child.search}
                  className="w-full cursor-pointer"
                >
                  {child.icon && <child.icon className="mr-2 h-4 w-4" />}
                  {child.title}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    return (
      <Link
        key={item.title}
        to={item.to!}
        search={item.search}
        className={styleClass}
      >
        <div className="flex items-center gap-2">
          {item.icon && <item.icon className="h-4 w-4" />}
          <span>{item.title}</span>
        </div>
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background px-6 shadow-sm">
      <div className="flex items-center gap-2 font-semibold">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="text-xs font-bold">YC</span>
        </div>
        <span className="hidden sm:inline-block">YouChannel 管理</span>
      </div>
      <nav className="flex items-center gap-4 md:gap-6 lg:gap-8 ml-6">
        {navItems.map(renderNavItem)}
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
