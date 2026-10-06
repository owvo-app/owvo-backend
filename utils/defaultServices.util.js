import { Service } from "../model/service.model.js";
import { User } from "../model/user.model.js";

export const defaultServices = [
  {
    catalogKey: "express-wash",
    serviceType: "basic",
    title: "Express Wash",
    price: 15,
    carSize: "small",
    carName: "Any car",
    carModel: "Any model",
    description: "Quick exterior clean - Exterior rinse & light hand wash - 10-12 mins",
    isActive: true,
  },
  {
    catalogKey: "essential-wash",
    serviceType: "basic",
    title: "Essential Wash",
    price: 20,
    carSize: "medium",
    carName: "Any car",
    carModel: "Any model",
    description: "Complete exterior clean & dry - Foam wash + hand dry + wheels cleaned - 15 mins",
    isActive: true,
  },
  {
    catalogKey: "standard-detail",
    serviceType: "standard",
    title: "Standard Detail",
    price: 25,
    carSize: "medium",
    carName: "Any car",
    carModel: "Any model",
    description: "Exterior + interior refresh - Exterior wash + vacuum + dashboard wipe - 18-20 mins",
    isActive: true,
  },
  {
    catalogKey: "premium-detail",
    serviceType: "premium",
    title: "Premium Detail",
    price: 35,
    carSize: "high",
    carName: "Any car",
    carModel: "Any model",
    description: "Full clean with premium finish - Full wash + interior clean + tyre shine + windows - 22-25 mins",
    isActive: true,
  },
  {
    catalogKey: "full-detail",
    serviceType: "premium",
    title: "Full Detail",
    price: 50,
    carSize: "high",
    carName: "Any car",
    carModel: "Any model",
    description: "Deep clean & full detailing service - Deep interior + leather care + exterior finish - 30-35 mins",
    isActive: true,
  },
];

const globalServiceFilter = {
  $or: [{ provider: null }, { provider: { $exists: false } }],
};

const defaultServicesByCatalogKey = new Map(
  defaultServices.map((service) => [service.catalogKey, service])
);

export const findDefaultServiceForPayload = (payload = {}) => {
  if (payload.catalogKey && defaultServicesByCatalogKey.has(payload.catalogKey)) {
    return defaultServicesByCatalogKey.get(payload.catalogKey);
  }

  const normalizedTitle = payload.title?.toString().trim().toLowerCase();
  if (!normalizedTitle) return null;

  return (
    defaultServices.find(
      (service) => service.title.toLowerCase() === normalizedTitle
    ) || null
  );
};

export const toPlainServices = (services) =>
  services.map((service) =>
    typeof service?.toObject === "function" ? service.toObject() : service
  );

// The catalog is DB-driven (admins can add/remove services). The hardcoded
// defaults are only seeded on a completely fresh database — never re-seeded,
// so deleting a service (even a default one) is permanent.
export const ensureDefaultServices = async () => {
  const catalogCount = await Service.countDocuments(globalServiceFilter);

  if (catalogCount === 0) {
    await Service.insertMany(
      defaultServices.map((service) => ({ ...service, provider: null }))
    );
  }

  return Service.find(globalServiceFilter).sort({ price: 1 });
};

export const syncProviderPreferredServices = async (providerId) => {
  const activeServices = await Service.find({
    provider: providerId,
    isActive: true,
  }).select("_id");

  await User.findByIdAndUpdate(providerId, {
    $set: { preferredServices: activeServices.map((service) => service._id) },
  });

  return activeServices;
};

export const ensureProviderServices = async (providerId) => {
  const catalog = await ensureDefaultServices();
  const catalogByKey = new Map(
    catalog.map((service) => [service.catalogKey, service])
  );
  const catalogKeys = [...catalogByKey.keys()].filter(Boolean);

  let providerServices = await Service.find({ provider: providerId }).sort({
    price: 1,
  });

  // Retire copies of catalog services that no longer exist.
  await Service.updateMany(
    {
      provider: providerId,
      catalogKey: { $exists: true, $nin: catalogKeys },
    },
    { $set: { isActive: false } }
  );

  for (const providerService of providerServices) {
    const catalogService =
      catalogByKey.get(providerService.catalogKey) ||
      findDefaultServiceForPayload(providerService);
    if (!catalogService) continue;

    const fixedFields = {
      serviceType: catalogService.serviceType,
      title: catalogService.title,
      price: catalogService.price,
      carSize: catalogService.carSize,
      carName: catalogService.carName,
      carModel: catalogService.carModel,
      description: catalogService.description,
    };

    let changed = false;
    Object.entries(fixedFields).forEach(([field, value]) => {
      if (providerService[field] !== value) {
        providerService[field] = value;
        changed = true;
      }
    });

    if (changed) {
      await providerService.save();
    }
  }

  const existingCatalogKeys = new Set(
    providerServices
      .map((service) => service.catalogKey)
      .filter((catalogKey) => catalogKeys.includes(catalogKey))
  );

  const missingServices = catalog.filter(
    (service) =>
      service.catalogKey && !existingCatalogKeys.has(service.catalogKey)
  );

  if (missingServices.length > 0) {
    const clonedServices = await Service.insertMany(
      missingServices.map((service) => ({
        catalogKey: service.catalogKey,
        serviceType: service.serviceType,
        title: service.title,
        price: service.price,
        carSize: service.carSize,
        carName: service.carName,
        carModel: service.carModel,
        description: service.description,
        isActive: service.isActive !== false,
        provider: providerId,
      }))
    );

    providerServices = [...providerServices, ...clonedServices];
  }

  await syncProviderPreferredServices(providerId);

  return Service.find({
    provider: providerId,
    catalogKey: { $in: catalogKeys },
  }).sort({ price: 1 });
};
