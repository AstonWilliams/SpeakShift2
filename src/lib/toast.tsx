// src/lib/toast.ts
import { CheckCircle, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { toast } from 'sonner';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

const toasts: Toast[] = [];
let listeners: ((toasts: Toast[]) => void)[] = [];

export function showToast(message: string, type: ToastType = 'info') {
  const id = Date.now().toString();
  toasts.push({ id, message, type });
  listeners.forEach((cb) => cb([...toasts]));
  
  setTimeout(() => {
    const index = toasts.findIndex(t => t.id === id);
    if (index !== -1) {
      toasts.splice(index, 1);
      listeners.forEach((cb) => cb([...toasts]));
    }
  }, 4000);
}

export function useToasts() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener = (updated: Toast[]) => setCurrentToasts(updated);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  }, []);

  return currentToasts;
}

// Components/Usage example in your layout or page:
export function ToastContainer() {
  const toasts = useToasts();

  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {toasts.map((toast: any) => (
        <div
          key={toast.id}
          className={`px-5 py-3 rounded-xl shadow-lg text-white flex items-center gap-3 max-w-sm ${
            toast.type === 'success' ? 'bg-green-600' :
            toast.type === 'error' ? 'bg-red-600' :
            'bg-blue-600'
          }`}
        >
          {toast.type === 'success' && <CheckCircle className="w-5 h-5" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5" />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}