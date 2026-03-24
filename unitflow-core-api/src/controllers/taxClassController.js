const prisma = require("../config/db");
const { getPagination, buildPaginationMeta } = require("../utils/pagination");

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

exports.listTaxClasses = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const q = (req.query.q || "").toString().trim();
    const is_active = (req.query.is_active || "true").toString() !== "false";
    const where = { company_id, is_active };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } }
      ];
    }

    const pagination = getPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
    const query = { where, orderBy: [{ updated_at: "desc" }, { id: "desc" }] };
    if (pagination.enabled) {
      query.skip = pagination.skip;
      query.take = pagination.take;
    }

    const [items, total] = await Promise.all([
      prisma.taxClass.findMany(query),
      pagination.enabled && pagination.include_total ? prisma.taxClass.count({ where }) : Promise.resolve(null)
    ]);

    if (!pagination.enabled) return res.json(items);
    return res.json({ items, pagination: buildPaginationMeta({ page: pagination.page, page_size: pagination.page_size, total: total ?? items.length }) });
  } catch (err) {
    console.error("listTaxClasses error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getTaxClassById = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const item = await prisma.taxClass.findFirst({ where: { id: req.params.id, company_id } });
    if (!item) return res.status(404).json({ message: "Tax class not found" });
    return res.json(item);
  } catch (err) {
    console.error("getTaxClassById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createTaxClass = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const gst_rate = toNumber(req.body?.gst_rate);
    const cess_rate = req.body?.cess_rate === undefined ? 0 : toNumber(req.body?.cess_rate);
    if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 100) return res.status(400).json({ message: "gst_rate must be between 0 and 100" });
    if (!Number.isFinite(cess_rate) || cess_rate < 0 || cess_rate > 100) return res.status(400).json({ message: "cess_rate must be between 0 and 100" });

    const item = await prisma.taxClass.create({
      data: {
        company_id,
        name,
        description: req.body?.description ? String(req.body.description).trim() : null,
        gst_rate,
        cess_rate,
        is_active: true
      }
    });
    return res.status(201).json(item);
  } catch (err) {
    console.error("createTaxClass error:", err);
    const status = err.code === "P2002" ? 409 : 500;
    return res.status(status).json({ message: err.code === "P2002" ? "Tax class already exists" : "Internal server error" });
  }
};

exports.updateTaxClass = async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const existing = await prisma.taxClass.findFirst({ where: { id: req.params.id, company_id } });
    if (!existing) return res.status(404).json({ message: "Tax class not found" });

    let gst_rate;
    if (req.body?.gst_rate !== undefined) {
      gst_rate = toNumber(req.body.gst_rate);
      if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 100) return res.status(400).json({ message: "gst_rate must be between 0 and 100" });
    }

    let cess_rate;
    if (req.body?.cess_rate !== undefined) {
      cess_rate = toNumber(req.body.cess_rate);
      if (!Number.isFinite(cess_rate) || cess_rate < 0 || cess_rate > 100) return res.status(400).json({ message: "cess_rate must be between 0 and 100" });
    }

    const item = await prisma.taxClass.update({
      where: { id: req.params.id },
      data: {
        name: req.body?.name !== undefined ? String(req.body.name).trim() : undefined,
        description: req.body?.description !== undefined ? (req.body.description ? String(req.body.description).trim() : null) : undefined,
        gst_rate: gst_rate !== undefined ? gst_rate : undefined,
        cess_rate: cess_rate !== undefined ? cess_rate : undefined,
        is_active: typeof req.body?.is_active === "boolean" ? req.body.is_active : undefined
      }
    });
    return res.json(item);
  } catch (err) {
    console.error("updateTaxClass error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
