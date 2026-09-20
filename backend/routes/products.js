const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

router.get('/', requirePermission('products', 'view'), (req, res) => {
  const { active, category, q } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (active !== undefined) { sql += ' AND active = ?'; params.push(active === '1' || active === 'true' ? 1 : 0); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (q) { sql += ' AND (product_name LIKE ? OR sku LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY product_name';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('products', 'view'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
});

router.post('/', requirePermission('products', 'create'), (req, res) => {
  const b = req.body;
  if (!b.product_name) return res.status(400).json({ error: 'product_name is required' });
  const info = db.prepare(`
    INSERT INTO products (
      product_name, sku, product_type, category, description, unit, selling_price, cost_price, tax_percent,
      currency, recurring, billing_frequency, active, owner_id
    ) VALUES (@product_name, @sku, @product_type, @category, @description, @unit, @selling_price, @cost_price, @tax_percent,
      @currency, @recurring, @billing_frequency, @active, @owner_id)
  `).run({
    sku: null, product_type: 'Product', category: null, description: null, unit: null, selling_price: 0, cost_price: 0,
    tax_percent: 0, currency: 'INR', recurring: 0, billing_frequency: null, active: 1, owner_id: null,
    ...b,
  });
  const created = db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid);
  fireWorkflows('products', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('products', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE products SET product_name=?, sku=?, product_type=?, category=?, description=?, unit=?, selling_price=?,
      cost_price=?, tax_percent=?, currency=?, recurring=?, billing_frequency=?, active=?, owner_id=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.product_name, m.sku, m.product_type, m.category, m.description, m.unit, m.selling_price, m.cost_price,
    m.tax_percent, m.currency, m.recurring ? 1 : 0, m.billing_frequency, m.active ? 1 : 0, m.owner_id, req.params.id);
  const updated = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  fireWorkflows('products', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('products', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission('products', 'delete'), (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
