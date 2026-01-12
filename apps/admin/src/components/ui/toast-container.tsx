import { useToast, type Toast, type ToastType } from "../../hooks/use-toast";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/utils";
import { useEffect, useState } from "react";

const ToastIcon = ({ type }: { type: ToastType }) => {
    switch (type) {
        case "success":
            return <CheckCircle2 className="h-5 w-5 text-green-500" />;
        case "error":
            return <AlertCircle className="h-5 w-5 text-destructive" />;
        case "warning":
            return <AlertTriangle className="h-5 w-5 text-amber-500" />;
        default:
            return <Info className="h-5 w-5 text-blue-500" />;
    }
};

const ToastItem = ({ toast }: { toast: Toast }) => {
    const { dismiss } = useToast();
    const [isVisible, setIsVisible] = useState(false);

    // Animation handling
    useEffect(() => {
        // Start animation in next frame
        requestAnimationFrame(() => setIsVisible(true));
    }, []);

    const handleDismiss = () => {
        setIsVisible(false);
        // Remove from state after animation completes
        setTimeout(() => {
            dismiss(toast.id);
        }, 300);
    };

    return (
        <div
            className={cn(
                "pointer-events-auto flex w-full max-w-sm overflow-hidden rounded-lg border bg-background shadow-lg transition-all duration-300 ease-in-out",
                isVisible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
            )}
            role="alert"
        >
            <div className="flex w-full p-4">
                <div className="shrink-0">
                    <ToastIcon type={toast.type || "default"} />
                </div>
                <div className="ml-3 w-0 flex-1 pt-0.5">
                    {toast.title && (
                        <p className="text-sm font-medium text-foreground">{toast.title}</p>
                    )}
                    {toast.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{toast.description}</p>
                    )}
                </div>
                <div className="ml-4 flex shrink-0">
                    <button
                        type="button"
                        className="inline-flex rounded-md bg-background text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                        onClick={handleDismiss}
                    >
                        <span className="sr-only">Close</span>
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>
            </div>
        </div>
    );
};

export function ToastContainer() {
    const { toasts } = useToast();

    return (
        <div
            aria-live="assertive"
            className="pointer-events-none fixed inset-0 z-50 flex flex-col items-end gap-2 px-4 py-6 sm:items-end sm:p-6 justify-end"
        >
            {toasts.map((toast) => (
                <ToastItem key={toast.id} toast={toast} />
            ))}
        </div>
    );
}
