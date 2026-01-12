import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type ToastType = "default" | "success" | "error" | "warning";

export interface Toast {
    id: string;
    title?: string;
    description?: string;
    type?: ToastType;
    duration?: number;
}

interface ToastContextType {
    toasts: Toast[];
    toast: (props: Omit<Toast, "id">) => void;
    dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const toast = useCallback(
        ({ duration = 3000, ...props }: Omit<Toast, "id">) => {
            const id = Math.random().toString(36).substring(2, 9);
            const newToast: Toast = { ...props, id, duration };

            setToasts((prev) => [...prev, newToast]);

            if (duration !== Infinity) {
                setTimeout(() => {
                    dismiss(id);
                }, duration);
            }
        },
        [dismiss]
    );

    return (
        <ToastContext.Provider value={{ toasts, toast, dismiss }}>
            {children}
        </ToastContext.Provider>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (context === undefined) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
}
