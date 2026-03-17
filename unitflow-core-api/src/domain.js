function completionStatusFromInvoiceStatus(status) {
  const s = String(status || "").toUpperCase();
  if (s === "PAID") return "COMPLETED";
  if (s === "VOID") return "VOID";
  return "PENDING";
}

function deriveInvoiceStatusFromPaidAmount({ invoiceStatus, paidAmount, totalAmount }) {
  const paid = Number(paidAmount || 0);
  const total = Number(totalAmount || 0);
  if (paid <= 0) {
    return ["PARTIALLY_PAID", "PAID"].includes(invoiceStatus) ? "PENDING" : invoiceStatus;
  }
  if (paid > 0 && paid < total) return "PARTIALLY_PAID";
  if (paid >= total) return "PAID";
  return invoiceStatus;
}

function validateDispatchAllocationTotals(orderItems = [], allocationRows = []) {
  const ordered = new Map();
  for (const item of orderItems) {
    const productId = String(item.product_id);
    ordered.set(productId, (ordered.get(productId) || 0) + Number(item.quantity || 0));
  }

  const allocated = new Map();
  for (const row of allocationRows) {
    const productId = String(row.product_id);
    allocated.set(productId, (allocated.get(productId) || 0) + Number(row.quantity || 0));
  }

  for (const [productId, orderedQty] of ordered.entries()) {
    const allocatedQty = Number(allocated.get(productId) || 0);
    if (Math.abs(orderedQty - allocatedQty) > 1e-9) {
      return { ok: false, product_id: productId, ordered_quantity: orderedQty, allocated_quantity: allocatedQty };
    }
  }

  return { ok: true };
}

module.exports = {
  completionStatusFromInvoiceStatus,
  deriveInvoiceStatusFromPaidAmount,
  validateDispatchAllocationTotals
};
