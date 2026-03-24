const prisma = require("../config/db");
const logActivity = require("../utils/activityLogger");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");
const { normalizeTrackingMode } = require("../services/trackedInventoryService");
const { toNumber, normalizeText } = require("../services/gstService");

function toStrOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toPriceOrUndefined(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

async function validateCategory(company_id, category_id) {
  if (!category_id) return null;
  const category = await prisma.productCategory.findFirst({
    where: { id: category_id, company_id, is_active: true }
  });
  if (!category) {
    const err = new Error("Category not found");
    err.statusCode = 404;
    throw err;
  }
  return category;
}

async function validateTaxClass(company_id, tax_class_id) {
  if (!tax_class_id) return null;
  const taxClass = await prisma.taxClass.findFirst({
    where: { id: tax_class_id, company_id, is_active: true }
  });
  if (!taxClass) {
    const err = new Error("Tax class not found");
    err.statusCode = 404;
    throw err;
  }
  return taxClass;
}

function buildProductMutationData(body = {}) {
  const priceValue = toPriceOrUndefined(body.price);
  if (priceValue !== undefined) {
    if (Number.isNaN(priceValue)) {
      const err = new Error("price is invalid");
      err.statusCode = 400;
      throw err;
    }
    if (priceValue < 0) {
      const err = new Error("price cannot be negative");
      err.statusCode = 400;
      throw err;
    }
  }

  const gstRate = body.gst_rate !== undefined ? toNumber(body.gst_rate) : undefined;
  const cessRate = body.cess_rate !== undefined ? toNumber(body.cess_rate) : undefined;
  if (gstRate !== undefined && (gstRate < 0 || gstRate > 100)) {
    const err = new Error("gst_rate must be between 0 and 100");
    err.statusCode = 400;
    throw err;
  }
  if (cessRate !== undefined && (cessRate < 0 || cessRate > 100)) {
    const err = new Error("cess_rate must be between 0 and 100");
    err.statusCode = 400;
    throw err;
  }

  return {
    category_id: body.category_id || undefined,
    tax_class_id: body.tax_class_id !== undefined ? (body.tax_class_id || null) : undefined,
    name: body.name !== undefined ? String(body.name).trim() : undefined,
    sku: body.sku !== undefined ? toStrOrNull(body.sku) : undefined,
    unit: body.unit !== undefined ? String(body.unit).trim() : undefined,
    pack_size: body.pack_size !== undefined ? toStrOrNull(body.pack_size) : undefined,
    price: priceValue !== undefined ? priceValue : undefined,
    hsn_sac_code: body.hsn_sac_code !== undefined ? normalizeText(body.hsn_sac_code) : undefined,
    gst_rate: body.gst_rate !== undefined ? gstRate : undefined,
    cess_rate: body.cess_rate !== undefined ? cessRate : undefined,
    tracking_mode: body.tracking_mode !== undefined ? normalizeTrackingMode(body.tracking_mode) : undefined,
    shelf_life_days: body.shelf_life_days !== undefined && body.shelf_life_days !== null && body.shelf_life_days !== ""
      ? Number(body.shelf_life_days)
      : (body.shelf_life_days === null ? null : undefined),
    description: body.description !== undefined ? toStrOrNull(body.description) : undefined,
    is_active: typeof body.is_active === "boolean" ? body.is_active : undefined
  };
}

exports.createProduct = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { category_id, name, unit } = req.body;

    if (!category_id) return res.status(400).json({ message: "category_id is required" });
    if (!name || !String(name).trim()) return res.status(400).json({ message: "name is required" });
    if (!unit || !String(unit).trim()) return res.status(400).json({ message: "unit is required" });

    await validateCategory(company_id, category_id);
    await validateTaxClass(company_id, req.body.tax_class_id);

    const trimmedName = String(name).trim();
    const trimmedPack = toStrOrNull(req.body.pack_size);

    const existing = await prisma.product.findFirst({
      where: { company_id, name: trimmedName, pack_size: trimmedPack }
    });

    const mutationData = buildProductMutationData(req.body);
    if (existing) {
      if (!existing.is_active) {
        const updated = await prisma.product.update({
          where: { id: existing.id },
          data: { ...mutationData, is_active: true },
          include: {
            category: { select: { id: true, name: true } },
            tax_class: true,
            product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
          }
        });

        await logActivity({ company_id, user_id: req.user.id, action: "PRODUCT_REACTIVATED", entity_type: "product", entity_id: updated.id, old_value: existing, new_value: updated });
        return res.status(200).json(updated);
      }
      return res.status(409).json({ message: "Product already exists" });
    }

    const product = await prisma.product.create({
      data: { company_id, ...mutationData, name: trimmedName, pack_size: trimmedPack, is_active: true },
      include: {
        category: { select: { id: true, name: true } },
        tax_class: true,
        product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
      }
    });

    if (req.body.primary_barcode) {
      await prisma.productBarcode.create({
        data: {
          company_id,
          product_id: product.id,
          code: String(req.body.primary_barcode).trim(),
          alias_type: "PRIMARY",
          is_primary: true,
          is_active: true
        }
      });
    }

    const hydrated = await prisma.product.findUnique({
      where: { id: product.id },
      include: {
        category: { select: { id: true, name: true } },
        tax_class: true,
        product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
      }
    });

    await logActivity({ company_id, user_id: req.user.id, action: "PRODUCT_CREATED", entity_type: "product", entity_id: product.id, new_value: hydrated });
    return res.status(201).json(hydrated);
  } catch (err) {
    console.error("createProduct error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.getProducts = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const q = (req.query.q || "").toString().trim();
    const category_id = (req.query.category_id || "").toString().trim();
    const tracking_mode = (req.query.tracking_mode || "").toString().trim();
    const tax_class_id = (req.query.tax_class_id || "").toString().trim();
    const is_active_param = (req.query.is_active || "").toString().trim();

    const is_active =
      is_active_param === "" ? true :
      is_active_param === "true" ? true :
      is_active_param === "false" ? false :
      true;

    const where = { company_id, is_active };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
        { pack_size: { contains: q, mode: "insensitive" } },
        { hsn_sac_code: { contains: q, mode: "insensitive" } },
        { product_barcodes: { some: { code: { contains: q, mode: "insensitive" }, is_active: true } } }
      ];
    }
    if (category_id) where.category_id = category_id;
    if (tracking_mode) where.tracking_mode = normalizeTrackingMode(tracking_mode);
    if (tax_class_id) where.tax_class_id = tax_class_id;

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = {
      where,
      orderBy: [{ updated_at: "desc" }, { id: "desc" }],
      include: {
        category: { select: { id: true, name: true } },
        tax_class: true,
        product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
      }
    };
    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.product.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(products);
    return res.json({
      items: products,
      pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? products.length })
    });
  } catch (err) {
    console.error("getProducts error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;

    const product = await prisma.product.findFirst({
      where: { id, company_id },
      include: {
        category: { select: { id: true, name: true } },
        tax_class: true,
        product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] },
        client_products: {
          where: { is_active: true },
          include: { client: { select: { id: true, company_name: true } } }
        },
        inventory_tracking_balances: {
          where: { quantity: { gt: 0 } },
          take: 25,
          include: { factory: { select: { id: true, name: true } }, batch: true, serial: true },
          orderBy: [{ updated_at: "desc" }]
        }
      }
    });

    if (!product) return res.status(404).json({ message: "Product not found" });
    return res.json(product);
  } catch (err) {
    console.error("getProductById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;

    const existing = await prisma.product.findFirst({ where: { id, company_id } });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    if (req.body.name !== undefined && (!req.body.name || !String(req.body.name).trim())) {
      return res.status(400).json({ message: "name cannot be empty" });
    }
    if (req.body.unit !== undefined && (!req.body.unit || !String(req.body.unit).trim())) {
      return res.status(400).json({ message: "unit cannot be empty" });
    }

    if (req.body.category_id) await validateCategory(company_id, req.body.category_id);
    if (req.body.tax_class_id !== undefined) await validateTaxClass(company_id, req.body.tax_class_id);

    const nextName = req.body.name ? String(req.body.name).trim() : existing.name;
    const nextPack = req.body.pack_size !== undefined ? toStrOrNull(req.body.pack_size) : existing.pack_size;
    if ((req.body.name && nextName !== existing.name) || (req.body.pack_size !== undefined && nextPack !== existing.pack_size)) {
      const dup = await prisma.product.findFirst({
        where: { company_id, name: nextName, pack_size: nextPack, id: { not: id } }
      });
      if (dup) return res.status(409).json({ message: "Another product with same name and pack size exists" });
    }

    const updated = await prisma.product.update({
      where: { id },
      data: buildProductMutationData(req.body),
      include: {
        category: { select: { id: true, name: true } },
        tax_class: true,
        product_barcodes: { where: { is_active: true }, orderBy: [{ is_primary: "desc" }, { code: "asc" }] }
      }
    });

    await logActivity({ company_id, user_id: req.user.id, action: "PRODUCT_UPDATED", entity_type: "product", entity_id: id, old_value: existing, new_value: updated });
    return res.json(updated);
  } catch (err) {
    console.error("updateProduct error:", err);
    return res.status(err.statusCode || 500).json({ message: err.message || "Internal server error" });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;

    const existing = await prisma.product.findFirst({ where: { id, company_id } });
    if (!existing) return res.status(404).json({ message: "Product not found" });

    await prisma.product.update({ where: { id }, data: { is_active: false } });
    await logActivity({ company_id, user_id: req.user.id, action: "PRODUCT_DELETED", entity_type: "product", entity_id: id, old_value: { is_active: existing.is_active }, new_value: { is_active: false } });
    return res.json({ message: "Product disabled (soft deleted)" });
  } catch (err) {
    console.error("deleteProduct error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.addProductBarcode = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id } = req.params;
    const code = String(req.body?.code || "").trim();
    if (!code) return res.status(400).json({ message: "code is required" });

    const product = await prisma.product.findFirst({ where: { id, company_id } });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const created = await prisma.$transaction(async (tx) => {
      if (req.body.is_primary) {
        await tx.productBarcode.updateMany({ where: { company_id, product_id: id }, data: { is_primary: false } });
      }
      return tx.productBarcode.create({
        data: {
          company_id,
          product_id: id,
          code,
          alias_type: req.body.alias_type ? String(req.body.alias_type).trim() : null,
          is_primary: Boolean(req.body.is_primary),
          is_active: true
        }
      });
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error("addProductBarcode error:", err);
    const msg = err.code === "P2002" ? "Barcode already exists" : (err.message || "Internal server error");
    return res.status(err.code === "P2002" ? 409 : 500).json({ message: msg });
  }
};

exports.removeProductBarcode = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { id, barcodeId } = req.params;
    const existing = await prisma.productBarcode.findFirst({ where: { id: barcodeId, company_id, product_id: id, is_active: true } });
    if (!existing) return res.status(404).json({ message: "Barcode not found" });
    await prisma.productBarcode.update({ where: { id: barcodeId }, data: { is_active: false, is_primary: false } });
    return res.json({ message: "Barcode removed" });
  } catch (err) {
    console.error("removeProductBarcode error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
