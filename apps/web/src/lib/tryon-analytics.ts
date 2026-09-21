export type AnalyticsEventName =
  | "page_view"
  | "product_select"
  | "camera_request"
  | "camera_grant"
  | "camera_error"
  | "tracking_start"
  | "tracking_error"
  | "screenshot"
  | "share"
  | "purchase_click";

export type DeviceKind = "mobile" | "tablet" | "desktop";

export type AnalyticsCounters = Record<AnalyticsEventName, number>;

export type ProductAnalytics = {
  productId: string;
  counters: AnalyticsCounters;
};

export type TryOnAnalyticsSnapshot = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  totals: AnalyticsCounters;
  products: Record<string, ProductAnalytics>;
  devices: Record<DeviceKind, number>;
  errors: Record<string, number>;
};

export type AnalyticsRecordOptions = {
  productId?: string;
  deviceKind?: DeviceKind;
  errorKind?: string;
  now?: string;
};

export type DeviceClassificationInput = {
  viewportWidth: number;
  coarsePointer: boolean;
  userAgent?: string;
};

const analyticsEvents: AnalyticsEventName[] = [
  "page_view",
  "product_select",
  "camera_request",
  "camera_grant",
  "camera_error",
  "tracking_start",
  "tracking_error",
  "screenshot",
  "share",
  "purchase_click",
];

const zeroCounters = (): AnalyticsCounters =>
  Object.fromEntries(analyticsEvents.map((eventName) => [eventName, 0])) as AnalyticsCounters;

const normalizeCounters = (value: unknown): AnalyticsCounters => {
  const counters = zeroCounters();
  if (!value || typeof value !== "object") return counters;
  const raw = value as Partial<Record<AnalyticsEventName, unknown>>;
  analyticsEvents.forEach((eventName) => {
    const count = raw[eventName];
    counters[eventName] =
      typeof count === "number" && Number.isFinite(count)
        ? Math.max(0, Math.round(count))
        : 0;
  });
  return counters;
};

export function createTryOnAnalytics(
  now = new Date().toISOString(),
): TryOnAnalyticsSnapshot {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    totals: zeroCounters(),
    products: {},
    devices: {
      mobile: 0,
      tablet: 0,
      desktop: 0,
    },
    errors: {},
  };
}

export function normalizeTryOnAnalytics(
  value: unknown,
  now = new Date().toISOString(),
): TryOnAnalyticsSnapshot {
  if (!value || typeof value !== "object") return createTryOnAnalytics(now);

  const raw = value as Partial<TryOnAnalyticsSnapshot>;
  const snapshot = createTryOnAnalytics(now);
  snapshot.createdAt =
    typeof raw.createdAt === "string" ? raw.createdAt : snapshot.createdAt;
  snapshot.updatedAt =
    typeof raw.updatedAt === "string" ? raw.updatedAt : snapshot.updatedAt;
  snapshot.totals = normalizeCounters(raw.totals);

  if (raw.devices && typeof raw.devices === "object") {
    const devices = raw.devices as Partial<Record<DeviceKind, unknown>>;
    snapshot.devices = {
      mobile:
        typeof devices.mobile === "number" && Number.isFinite(devices.mobile)
          ? Math.max(0, Math.round(devices.mobile))
          : 0,
      tablet:
        typeof devices.tablet === "number" && Number.isFinite(devices.tablet)
          ? Math.max(0, Math.round(devices.tablet))
          : 0,
      desktop:
        typeof devices.desktop === "number" && Number.isFinite(devices.desktop)
          ? Math.max(0, Math.round(devices.desktop))
          : 0,
    };
  }

  if (raw.products && typeof raw.products === "object") {
    Object.entries(raw.products).forEach(([productId, productValue]) => {
      if (!productValue || typeof productValue !== "object") return;
      snapshot.products[productId] = {
        productId,
        counters: normalizeCounters(
          (productValue as Partial<ProductAnalytics>).counters,
        ),
      };
    });
  }

  if (raw.errors && typeof raw.errors === "object") {
    Object.entries(raw.errors).forEach(([errorKind, count]) => {
      if (typeof count !== "number" || !Number.isFinite(count)) return;
      snapshot.errors[errorKind] = Math.max(0, Math.round(count));
    });
  }

  return snapshot;
}

export function recordTryOnEvent(
  snapshot: TryOnAnalyticsSnapshot,
  eventName: AnalyticsEventName,
  options: AnalyticsRecordOptions = {},
): TryOnAnalyticsSnapshot {
  const now = options.now ?? new Date().toISOString();
  const next: TryOnAnalyticsSnapshot = {
    ...snapshot,
    updatedAt: now,
    totals: {
      ...snapshot.totals,
      [eventName]: snapshot.totals[eventName] + 1,
    },
    products: { ...snapshot.products },
    devices: { ...snapshot.devices },
    errors: { ...snapshot.errors },
  };

  if (options.deviceKind && eventName === "page_view") {
    next.devices[options.deviceKind] += 1;
  }

  if (options.errorKind) {
    next.errors[options.errorKind] = (next.errors[options.errorKind] ?? 0) + 1;
  }

  if (options.productId) {
    const product = snapshot.products[options.productId] ?? {
      productId: options.productId,
      counters: zeroCounters(),
    };
    next.products[options.productId] = {
      productId: options.productId,
      counters: {
        ...product.counters,
        [eventName]: product.counters[eventName] + 1,
      },
    };
  }

  return next;
}

export function summarizeProductAnalytics(
  snapshot: TryOnAnalyticsSnapshot,
  productId: string,
) {
  return snapshot.products[productId]?.counters ?? zeroCounters();
}

export function calculateRate(part: number, total: number) {
  if (total <= 0) return null;
  return Math.round((part / total) * 100);
}

export function classifyDevice({
  viewportWidth,
  coarsePointer,
  userAgent = "",
}: DeviceClassificationInput): DeviceKind {
  const normalizedAgent = userAgent.toLowerCase();

  if (/ipad|tablet/.test(normalizedAgent)) return "tablet";
  if (/iphone|ipod|windows phone/.test(normalizedAgent)) return "mobile";
  if (/android/.test(normalizedAgent)) {
    return /mobile/.test(normalizedAgent) || viewportWidth < 760
      ? "mobile"
      : "tablet";
  }
  if (coarsePointer && viewportWidth < 760) return "mobile";
  if (coarsePointer && viewportWidth < 1100) return "tablet";
  return "desktop";
}
