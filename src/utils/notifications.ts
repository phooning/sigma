import { type ExternalToast, toast } from "sonner";

type NotificationOptions = Omit<ExternalToast, "description"> & {
  description?: unknown;
};

const getNotificationDescription = (description: unknown) => {
  if (description == null) return undefined;
  if (description instanceof Error) return description.message;

  return String(description);
};

const withDescription = ({
  description,
  ...options
}: NotificationOptions = {}): ExternalToast => {
  const normalizedDescription = getNotificationDescription(description);

  return normalizedDescription === undefined
    ? options
    : { ...options, description: normalizedDescription };
};

type ToastType = "success" | "info" | "warning" | "error";

const createNotifyMethod = (method: ToastType) => {
  return (title: string, options?: NotificationOptions) =>
    toast[method](title, withDescription(options));
};

export const notify = {
  success: createNotifyMethod("success"),
  info: createNotifyMethod("info"),
  warning: createNotifyMethod("warning"),
  error: createNotifyMethod("error"),
};
