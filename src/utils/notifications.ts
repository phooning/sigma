import { toast, type ExternalToast } from "sonner";

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

export const notify = {
  success: (title: string, options?: NotificationOptions) =>
    toast.success(title, withDescription(options)),
  info: (title: string, options?: NotificationOptions) =>
    toast.info(title, withDescription(options)),
  warning: (title: string, options?: NotificationOptions) =>
    toast.warning(title, withDescription(options)),
  error: (title: string, options?: NotificationOptions) =>
    toast.error(title, withDescription(options)),
};
