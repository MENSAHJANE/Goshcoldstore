import { lazy, Suspense, useEffect, useState } from 'react'
import FinanceWorkspace from './FinanceWorkspace.tsx'
import { parseApiResponse } from './api.ts'
import './App.css'
import './dashboard.css'

const InventoryChart = lazy(() => import('./InventoryChart.tsx'))

type Product = {
  id: number
  name: string
  category: string
  unit: string
  stock: number
  minimum: number
  cost: number
  price: number
  kiloPrice: number
  kgPerCarton: number
  status: 'Active' | 'Inactive'
}

type Movement = {
  id: number
  product: string
  kind: 'Goods received' | 'Adjustment'
  quantity: number
  supplier: string
  date: string
}

const initialProducts: Product[] = [
  { id: 1, name: 'Frozen Chicken 1kg', category: 'Poultry', unit: 'carton', stock: 42, minimum: 12, cost: 420, price: 600, kiloPrice: 35, kgPerCarton: 18, status: 'Active' },
  { id: 2, name: 'Tilapia Fillet', category: 'Seafood', unit: 'carton', stock: 8, minimum: 10, cost: 420, price: 600, kiloPrice: 35, kgPerCarton: 18, status: 'Active' },
  { id: 3, name: 'Beef Sausages', category: 'Meat', unit: 'pack', stock: 26, minimum: 8, cost: 4.2, price: 6.5, kiloPrice: 6.5, kgPerCarton: 1, status: 'Active' },
  { id: 4, name: 'Vanilla Ice Cream', category: 'Desserts', unit: 'tub', stock: 5, minimum: 6, cost: 9, price: 13, kiloPrice: 13, kgPerCarton: 1, status: 'Active' },
  { id: 5, name: 'Frozen Peas', category: 'Vegetables', unit: 'carton', stock: 31, minimum: 10, cost: 420, price: 600, kiloPrice: 35, kgPerCarton: 18, status: 'Active' },
]

const initialMovements: Movement[] = [
  { id: 1, product: 'Frozen Chicken 1kg', kind: 'Goods received', quantity: 24, supplier: 'Northstar Foods', date: 'Today, 09:42' },
  { id: 2, product: 'Tilapia Fillet', kind: 'Adjustment', quantity: -2, supplier: 'Stock count', date: 'Today, 08:15' },
  { id: 3, product: 'Beef Sausages', kind: 'Goods received', quantity: 12, supplier: 'Farm & Sea Ltd', date: 'Yesterday' },
]

const today = new Date()
const topbarDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today)
const eyebrowDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today).toUpperCase()
const money = (value: number) => `GH₵ ${value.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type SessionUser = { id: number; name: string; email: string; role: 'admin' | 'attendant' }
type DashboardData = { totalProducts: number; currentStock: number; lowStockCount: number; todayPurchases: number; todaySales: number | null; todayExpenses: number | null; currentProfit: number | null }

async function apiRequest<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  })
  return parseApiResponse<T>(response)
}

function fromApiProduct(product: Record<string, unknown>): Product {
  return {
    id: Number(product.id), name: String(product.name), category: String(product.category), unit: String(product.unit),
    stock: Number(product.currentStock ?? 0), minimum: Number(product.minimumStock ?? 0),
    cost: Number(product.costPrice ?? 0), price: Number(product.sellingPrice ?? 0),
    kiloPrice: Number(product.kiloPrice ?? product.sellingPrice ?? 0), kgPerCarton: Number(product.kgPerCarton ?? 1),
    status: product.active === false ? 'Inactive' : 'Active',
  }
}

async function loadApiInventory(token: string) {
  const [productResult, historyResult, dashboard] = await Promise.all([
    apiRequest<{ products: Record<string, unknown>[] }>('/api/products?includeInactive=true', token),
    apiRequest<{ movements: Record<string, unknown>[] }>('/api/stock/history', token),
    apiRequest<DashboardData>('/api/dashboard', token),
  ])
  return {
    products: productResult.products.map(fromApiProduct),
    movements: historyResult.movements.map((movement) => ({
      id: Number(movement.id), product: String(movement.productName),
      kind: movement.type === 'received' ? 'Goods received' as const : 'Adjustment' as const,
      quantity: Number(movement.quantity), supplier: String(movement.supplier || movement.note || 'Stock adjustment'),
      date: new Date(String(movement.createdAt)).toLocaleString(),
    })),
    dashboard,
  }
}

function App() {
  const [activeView, setActiveView] = useState('Overview')
  const [products, setProducts] = useState(initialProducts)
  const [movements, setMovements] = useState(initialMovements)
  const [modal, setModal] = useState<'product' | 'edit' | 'receive' | 'adjust' | 'user' | 'password' | null>(null)
  const [editProduct, setEditProduct] = useState<Product | null>(null)
  const [notice, setNotice] = useState('')
  const [role, setRole] = useState<'Admin' | 'Shop Attendant'>('Admin')
  const [token, setToken] = useState(() => localStorage.getItem('essumans-cold-store-token') || localStorage.getItem('frostline-token') || '')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [users, setUsers] = useState<Array<SessionUser & { active: boolean }>>([])
  const [dashboard, setDashboard] = useState<DashboardData>({ totalProducts: 0, currentStock: 0, lowStockCount: 0, todayPurchases: 912.5, todaySales: null, todayExpenses: null, currentProfit: null })
  const [authStatus, setAuthStatus] = useState<'loading' | 'login' | 'setup' | 'authenticated'>('loading')
  const [authError, setAuthError] = useState('')
  const [preview, setPreview] = useState(false)
  const currentRole = user ? (user.role === 'admin' ? 'Admin' : 'Shop Attendant') : role
  const activeProducts = products.filter((product) => product.status === 'Active')
  const lowStock = activeProducts.filter((product) => product.stock <= product.minimum)
  const currentView = activeView === 'Products' ? 'Product catalogue' : activeView === 'Stock' ? 'Stock management' : activeView === 'History' ? 'Stock history' : activeView === 'Users' ? 'User management' : activeView === 'Sales' ? 'Point of sale' : activeView === 'Finance' ? 'Daily finance' : activeView === 'Transactions' ? 'Transactions' : activeView === 'Approvals' ? 'Adjustment approvals' : activeView === 'Receipts' ? 'Receipt search' : activeView === 'Receipt' ? 'Sales receipt' : 'Store overview'

  useEffect(() => {
    let cancelled = false
    async function initialize() {
      try {
        if (token) {
          const result = await apiRequest<{ user: SessionUser }>('/api/auth/me', token)
          const inventory = await loadApiInventory(token)
          if (cancelled) return
          setUser(result.user)
          setProducts(inventory.products)
          setMovements(inventory.movements)
          setDashboard(inventory.dashboard)
          if (result.user.role === 'admin') {
            const userResult = await apiRequest<{ users: Array<SessionUser & { active: boolean }> }>('/api/users', token)
            setUsers(userResult.users)
          }
          setAuthStatus('authenticated')
          return
        }
        const result = await apiRequest<{ needsSetup: boolean }>('/api/auth/setup')
        if (!cancelled) setAuthStatus(result.needsSetup ? 'setup' : 'login')
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unable to reach the store API'
          if (message.includes('HTTP 401') || message.includes('Invalid or expired token') || message.includes('Account is no longer active')) {
            localStorage.removeItem('essumans-cold-store-token')
            localStorage.removeItem('frostline-token')
            setToken('')
          }
          setAuthError(message)
          setAuthStatus('login')
        }
      }
    }
    void initialize()
    return () => { cancelled = true }
  }, [token])

  async function authenticate(formData: FormData) {
    setAuthError('')
    try {
      const isSetup = authStatus === 'setup'
      const path = isSetup ? '/api/auth/bootstrap' : '/api/auth/login'
      const result = await apiRequest<{ token: string; user: SessionUser }>(path, undefined, { method: 'POST', body: JSON.stringify(Object.fromEntries(formData)) })
      localStorage.setItem('essumans-cold-store-token', result.token)
      localStorage.removeItem('frostline-token')
      setUser(result.user)
      setToken(result.token)
      const inventory = await loadApiInventory(result.token)
      setProducts(inventory.products)
      setMovements(inventory.movements)
      setDashboard(inventory.dashboard)
      if (result.user.role === 'admin') {
        const userResult = await apiRequest<{ users: Array<SessionUser & { active: boolean }> }>('/api/users', result.token)
        setUsers(userResult.users)
      }
      setAuthStatus('authenticated')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign in')
    }
  }

  async function refreshApiInventory() {
    if (!token) return
    const inventory = await loadApiInventory(token)
    setProducts(inventory.products)
    setMovements(inventory.movements)
    setDashboard(inventory.dashboard)
  }

  async function toggleProductStatus(id: number) {
    const product = products.find((item) => item.id === id)
    if (!product) return
    if (token && !preview) {
      try {
        await apiRequest(`/api/products/${id}`, token, { method: 'PATCH', body: JSON.stringify({ active: product.status !== 'Active' }) })
        await refreshApiInventory()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Unable to update product status')
      }
      return
    }
    setProducts((current) => current.map((item) => item.id === id ? { ...item, status: item.status === 'Active' ? 'Inactive' : 'Active' } : item))
  }

  async function submitUser(formData: FormData) {
    if (!token) return
    try {
      await apiRequest('/api/users', token, { method: 'POST', body: JSON.stringify(Object.fromEntries(formData)) })
      const result = await apiRequest<{ users: Array<SessionUser & { active: boolean }> }>('/api/users', token)
      setUsers(result.users)
      setModal(null)
      showNotice('User account created')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to create user')
    }
  }

  async function submitPassword(formData: FormData) {
    if (!token) return
    try {
      await apiRequest('/api/auth/password', token, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(formData)) })
      setModal(null)
      showNotice('Password updated')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to update password')
    }
  }

  async function toggleUserStatus(id: number) {
    if (!token) return
    try {
      await apiRequest(`/api/users/${id}/active`, token, { method: 'PATCH' })
      const result = await apiRequest<{ users: Array<SessionUser & { active: boolean }> }>('/api/users', token)
      setUsers(result.users)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to update user')
    }
  }

  function applyPreviewSale(items: Array<{ productId: number; productName: string; quantity: number; stockQuantity?: number }>) {
    setProducts((current) => current.map((product) => {
      const sold = items.filter((item) => item.productId === product.id).reduce((sum, item) => sum + (item.stockQuantity ?? item.quantity), 0)
      return sold ? { ...product, stock: Math.max(0, product.stock - sold) } : product
    }))
    setMovements((current) => [...items.map((item) => ({ id: Date.now() + item.productId, product: item.productName, kind: 'Adjustment' as const, quantity: -(item.stockQuantity ?? item.quantity), supplier: 'Sale completed', date: 'Just now' })), ...current])
  }

  function reversePreviewSale(items: Array<{ productId: number; productName: string; quantity: number; stockQuantity?: number }>) {
    setProducts((current) => current.map((product) => {
      const returned = items.filter((item) => item.productId === product.id).reduce((sum, item) => sum + (item.stockQuantity ?? item.quantity), 0)
      return returned ? { ...product, stock: product.stock + returned } : product
    }))
    setMovements((current) => [...items.map((item) => ({ id: Date.now() + item.productId, product: item.productName, kind: 'Adjustment' as const, quantity: item.stockQuantity ?? item.quantity, supplier: 'Sale reversed', date: 'Just now' })), ...current])
  }

  function signOut() {
    localStorage.removeItem('essumans-cold-store-token')
    localStorage.removeItem('frostline-token')
    setToken('')
    setUser(null)
    setPreview(false)
    setAuthStatus('login')
  }

  if (authStatus === 'loading' && !preview) return <div className="auth-screen"><div className="auth-card"><span className="brand-mark">E</span><h1>Essuman's Cold Store</h1><p>Connecting to your store...</p></div></div>

  if (authStatus !== 'authenticated' && !preview) return <main className="auth-screen"><section className="auth-card"><a className="brand auth-brand" href="#login"><span className="brand-mark">E</span><span>ESSUMAN'S <span className="brand-light">COLD STORE</span><small>INVENTORY & OPERATIONS</small></span></a><span className="eyebrow">ACCRA · COLD STORE</span><h1>{authStatus === 'setup' ? 'Set up your store' : 'Welcome back'}</h1><p className="auth-subtitle">{authStatus === 'setup' ? 'Create the first administrator account to secure your inventory.' : 'Sign in to manage your store inventory.'}</p><form action={(data) => void authenticate(data)}>{authStatus === 'setup' && <label>Your name<input name="name" autoComplete="name" required minLength={2} placeholder="Store administrator" /></label>}<label>Email address<input name="email" type="email" autoComplete="username" required placeholder="you@yourstore.com" /></label><label>Password<input name="password" type="password" autoComplete={authStatus === 'setup' ? 'new-password' : 'current-password'} minLength={authStatus === 'setup' ? 10 : 1} required placeholder={authStatus === 'setup' ? 'At least 10 characters' : 'Your password'} /></label>{authError && <p className="auth-error" role="alert">{authError}</p>}<button className="button button-primary auth-submit" type="submit">{authStatus === 'setup' ? 'Create administrator' : 'Sign in'} <span>→</span></button></form><button className="preview-link" onClick={() => setPreview(true)}>Preview sample dashboard</button></section><p className="auth-footer">Secure inventory management · Phase 1</p></main>

  async function submitProduct(formData: FormData) {
    const name = String(formData.get('name') || '').trim()
    if (!name) return
    const nextProduct: Product = {
      id: editProduct?.id ?? Date.now(), name, category: String(formData.get('category') || 'General'),
      unit: String(formData.get('unit') || 'piece'), stock: editProduct?.stock ?? Number(formData.get('stock') || 0),
      minimum: Number(formData.get('minimum') || 0), cost: Number(formData.get('cost') || 0),
      price: Number(formData.get('price') || 0), kiloPrice: Number(formData.get('kiloPrice') || formData.get('price') || 0),
      kgPerCarton: Math.max(0.001, Number(formData.get('kgPerCarton') || 1)), status: editProduct?.status ?? 'Active',
    }
    if (token && !preview) {
      try {
        const payload = { name: nextProduct.name, category: nextProduct.category, unit: nextProduct.unit, costPrice: nextProduct.cost, sellingPrice: nextProduct.price, kiloPrice: nextProduct.kiloPrice, kgPerCarton: nextProduct.kgPerCarton, minimumStock: nextProduct.minimum, ...(!editProduct ? { currentStock: nextProduct.stock } : {}) }
        await apiRequest(editProduct ? `/api/products/${editProduct.id}` : '/api/products', token, { method: editProduct ? 'PATCH' : 'POST', body: JSON.stringify(payload) })
        await refreshApiInventory()
      } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to save product'); return }
    } else if (editProduct) setProducts((current) => current.map((item) => item.id === editProduct.id ? nextProduct : item))
    else setProducts((current) => [nextProduct, ...current])
    setModal(null)
    setEditProduct(null)
    setNotice(editProduct ? `${name} updated` : `${name} added to the catalogue`)
  }

  async function submitMovement(formData: FormData, kind: Movement['kind']) {
    const productId = Number(formData.get('product'))
    const quantity = Number(formData.get('quantity') || 0) * (kind === 'Adjustment' && formData.get('direction') === 'remove' ? -1 : 1)
    const product = products.find((item) => item.id === productId)
    if (!product || quantity === 0) return
    if (token && !preview) {
      try {
        const receiving = kind === 'Goods received'
        const result = await apiRequest<{ request?: unknown }>(receiving ? '/api/stock/receive' : '/api/stock/adjustments', token, { method: 'POST', body: JSON.stringify(receiving
          ? { productId, quantity: Math.abs(quantity), unitCost: Number(formData.get('cost')), supplier: String(formData.get('supplier')) }
          : { productId, quantity, note: String(formData.get('supplier')) }) })
        if (!receiving && result.request) {
          setModal(null)
          setNotice('Adjustment sent to an administrator for approval')
          return
        }
        await refreshApiInventory()
      } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to record stock movement'); return }
    } else {
      setProducts((current) => current.map((item) => item.id === productId ? { ...item, stock: Math.max(0, item.stock + quantity) } : item))
      setMovements((current) => [{ id: Date.now(), product: product.name, kind, quantity, supplier: String(formData.get('supplier') || (kind === 'Adjustment' ? 'Stock count' : 'Unspecified supplier')), date: 'Just now' }, ...current])
    }
    setModal(null)
    setNotice(kind === 'Goods received' ? `Received ${quantity} ${product.unit} of ${product.name}` : 'Stock adjustment recorded')
  }

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3200)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setActiveView('Overview')}>
          <span className="brand-mark">E</span><span>ESSUMAN'S <span className="brand-light">COLD STORE</span><small>INVENTORY & OPERATIONS</small></span>
        </a>
        <div className="store-switch"><span className="store-avatar">E</span><span><strong>Essuman's Cold Store</strong><small>Cold store · Accra</small></span><span className="chevron">⌄</span></div>
        <span className="nav-label">WORKSPACE</span>
        <nav className="primary-nav" aria-label="Main navigation">
          {[
            ['Overview', '▦'], ['Sales', '↗'], ['Receipts', '▧'], ['Products', '▤'], ['Stock', '⇅'], ['History', '◷'], ['Finance', '₵'],
          ].map(([label, icon]) => <button className={`nav-item ${activeView === label ? 'selected' : ''}`} key={label} onClick={() => setActiveView(label)}><span className="nav-icon">{icon}</span>{label}{label === 'Stock' && lowStock.length > 0 && <span className="nav-count">{lowStock.length}</span>}</button>)}
        </nav>
        {currentRole === 'Admin' && <><span className="nav-label settings-label">MANAGEMENT</span><button className={`nav-item ${activeView === 'Transactions' ? 'selected' : ''}`} onClick={() => setActiveView('Transactions')}><span className="nav-icon">⇄</span>Transactions</button><button className={`nav-item ${activeView === 'Approvals' ? 'selected' : ''}`} onClick={() => setActiveView('Approvals')}><span className="nav-icon">✓</span>Approvals</button><button className={`nav-item ${activeView === 'Users' ? 'selected' : ''}`} onClick={() => setActiveView('Users')}><span className="nav-icon">♙</span>Users</button></>}
        <div className="sidebar-spacer" />
        <div className="sidebar-help"><span className="help-symbol">?</span><span><strong>Need a hand?</strong><small>Visit the help center</small></span><span className="chevron">↗</span></div>
        <button className="profile" onClick={preview ? () => setRole(role === 'Admin' ? 'Shop Attendant' : 'Admin') : () => setModal('password')} aria-label={preview ? 'Switch preview role' : 'Change password'}><span className="profile-avatar">{user ? user.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() : 'AM'}</span><span><strong>{user?.name || 'Sample account'}</strong><small>{preview ? `${currentRole} · Preview` : `${currentRole} · Account`}</small></span><span className="chevron">{preview ? '···' : '⚙'}</span></button>
      </aside>

      <main className="main-panel">
        <header className="topbar"><div className="breadcrumbs"><span>Essuman's Cold Store</span><span>/</span><strong>{activeView}</strong>{preview && <span className="preview-badge">PREVIEW</span>}</div><div className="top-actions"><span className="today-label">{topbarDate}</span><button className="icon-button notification-button" title="Notifications" aria-label="Notifications" onClick={() => showNotice(`${lowStock.length} products need attention`)}>♧{lowStock.length > 0 && <i />}</button><span className="top-avatar">{user ? user.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() : 'AM'}</span></div></header>
        <div className="page-content">
          <div className="welcome-row"><div><p className="eyebrow">{eyebrowDate} <span className="live-dot" /> STORE OPEN</p><h1>{currentView}</h1><p className="page-subtitle">Here’s what’s happening at your store today.</p></div>{['Overview', 'Products', 'Stock'].includes(activeView) && <div className="action-row"><button className="button button-secondary" onClick={() => setModal('adjust')}><span>⇄</span> Adjust stock</button>{currentRole === 'Admin' && <button className="button button-primary" onClick={() => { setEditProduct(null); setModal('product') }}><span>＋</span> Add product</button>}</div>}</div>

          {activeView === 'Overview' && <>
            <section className="metrics-grid" aria-label="Store metrics">
              <article className="metric-card"><div className="metric-top"><span>Total products</span><span className="metric-icon products-icon">▤</span></div><strong>{activeProducts.length}</strong><p><span className="metric-muted">Across</span> {new Set(activeProducts.map((item) => item.category)).size} categories</p></article>
              <article className="metric-card"><div className="metric-top"><span>Current stock</span><span className="metric-icon stock-icon">▥</span></div><strong>{activeProducts.reduce((sum, item) => sum + item.stock, 0)} <small>units</small></strong><p><span className="metric-muted">{lowStock.length} products need attention</span></p></article>
              <article className="metric-card"><div className="metric-top"><span>Today's purchases</span><span className="metric-icon purchases-icon">↙</span></div><strong>{money(dashboard.todayPurchases)}</strong><p><span className="metric-muted">Goods received today</span></p></article>
              <article className="metric-card"><div className="metric-top"><span>Today's sales</span><span className="metric-icon sales-icon">↗</span></div><strong>{dashboard.todaySales === null ? '—' : money(dashboard.todaySales)}</strong><p><span className="metric-muted">{dashboard.todaySales === null ? 'Sales not tracked yet' : 'Recorded today'}</span></p></article>
              <article className="metric-card"><div className="metric-top"><span>Today's expenses</span><span className="metric-icon purchases-icon">−</span></div><strong>{dashboard.todayExpenses === null ? '—' : money(dashboard.todayExpenses)}</strong><p><span className="metric-muted">{dashboard.todayExpenses === null ? 'Expenses not tracked yet' : 'Recorded today'}</span></p></article>
              <article className="metric-card"><div className="metric-top"><span>Today's profit</span><span className="metric-icon stock-icon">∑</span></div><strong>{dashboard.currentProfit === null ? '—' : money(dashboard.currentProfit)}</strong><p><span className="metric-muted">{dashboard.currentProfit === null ? 'Requires sales tracking' : 'Sales margin + income − expenses'}</span></p></article>
            </section>

            <section className="overview-grid">
              <article className="panel inventory-panel"><div className="panel-heading"><div><h2>Inventory health</h2><p>Stock levels across active products</p></div><button className="text-button" onClick={() => setActiveView('Products')}>View catalogue <span>→</span></button></div>
                <div className="inventory-summary"><div><strong>{activeProducts.reduce((sum, item) => sum + item.stock, 0)}</strong><span>total units</span></div><div className="summary-divider" /><div><strong className="warning-number">{lowStock.length}</strong><span>need attention</span></div><div className="inventory-legend"><span><i className="legend-ok" /> Healthy</span><span><i className="legend-low" /> Low stock</span></div></div>
                <Suspense fallback={<div className="chart-loading">Loading inventory chart...</div>}><InventoryChart products={products} /></Suspense>
              </article>
              <article className="panel attention-panel"><div className="panel-heading"><div><h2>Needs attention</h2><p>Products at or below minimum</p></div><span className="attention-total">{lowStock.length}</span></div>{lowStock.length === 0 ? <div className="empty-state">All products are above their minimum levels.</div> : <div className="attention-list">{lowStock.map((product) => <div className="attention-item" key={product.id}><span className="attention-indicator">!</span><span className="attention-product"><strong>{product.name}</strong><small>{product.category}</small></span><span className="attention-quantity"><strong>{product.stock}</strong><small>min {product.minimum}</small></span></div>)}</div>}<button className="attention-action" onClick={() => setActiveView('Stock')}>Review stock <span>→</span></button></article>
            </section>

            <section className="panel movement-panel"><div className="panel-heading"><div><h2>Recent stock activity</h2><p>Latest goods received and adjustments</p></div><div className="movement-actions"><button className="button button-small button-secondary" onClick={() => setModal('receive')}>＋ Receive goods</button><button className="text-button" onClick={() => setActiveView('History')}>Full history <span>→</span></button></div></div><MovementTable movements={movements.slice(0, 4)} /></section>
          </>}

          {activeView === 'Products' && <section className="panel data-panel"><div className="panel-heading"><div><h2>Product catalogue</h2><p>{products.length} products in your store</p></div><div className="movement-actions"><input className="search-input" placeholder="Search products" aria-label="Search products" onChange={(event) => document.querySelectorAll<HTMLTableRowElement>('[data-product-row]').forEach((row) => { row.hidden = !row.innerText.toLowerCase().includes(event.target.value.toLowerCase()) })} />{currentRole === 'Admin' && <button className="button button-small button-primary" onClick={() => { setEditProduct(null); setModal('product') }}>＋ Add product</button>}</div></div><ProductTable products={products} canEdit={currentRole === 'Admin'} onEdit={(product) => { setEditProduct(product); setModal('edit') }} onToggle={(id) => void toggleProductStatus(id)} /></section>}

          {activeView === 'Stock' && <section className="panel data-panel"><div className="panel-heading"><div><h2>Stock management</h2><p>Current quantities and reorder thresholds</p></div><div className="movement-actions"><button className="button button-small button-secondary" onClick={() => setModal('adjust')}>⇄ Adjust stock</button><button className="button button-small button-primary" onClick={() => setModal('receive')}>＋ Receive goods</button></div></div><ProductTable products={products} canEdit={false} onEdit={() => undefined} onToggle={() => undefined} /></section>}

          {activeView === 'History' && <section className="panel data-panel"><div className="panel-heading"><div><h2>Stock history</h2><p>Goods received and manual adjustments</p></div><button className="button button-small button-primary" onClick={() => setModal('receive')}>＋ Receive goods</button></div><MovementTable movements={movements} /></section>}

          {activeView === 'Users' && <section className="panel data-panel"><div className="panel-heading"><div><h2>Store users</h2><p>Administrator and shop attendant access</p></div>{!preview && <button className="button button-small button-primary" onClick={() => setModal('user')}>＋ Add user</button>}</div>{preview ? <div className="empty-state">User administration requires a signed-in administrator account.</div> : <div className="table-scroll"><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th /></tr></thead><tbody>{users.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.email}</td><td>{item.role === 'admin' ? 'Administrator' : 'Shop Attendant'}</td><td><span className={`status-tag ${item.active ? 'status-active' : 'status-inactive'}`}>{item.active ? 'Active' : 'Inactive'}</span></td><td>{user?.id !== item.id && <button className="row-action" onClick={() => void toggleUserStatus(item.id)}>{item.active ? 'Disable' : 'Enable'}</button>}</td></tr>)}</tbody></table>{users.length === 0 && <div className="empty-state">No users found.</div>}</div>}</section>}

          <FinanceWorkspace view={activeView} products={products} token={token} preview={preview} role={user?.role ?? 'admin'} userId={user?.id ?? 0} userName={user?.name ?? 'Sample account'} onInventoryChanged={() => void refreshApiInventory()} onPreviewSale={applyPreviewSale} onPreviewReversal={reversePreviewSale} onFinanceChanged={() => { if (token && !preview) void apiRequest<DashboardData>('/api/dashboard', token).then(setDashboard).catch(() => undefined) }} onNavigate={setActiveView} onNotice={showNotice} />

          <footer className="page-footer"><span>Essuman's Cold Store inventory</span><span>Phase 2 · Daily operations & finance</span></footer>
        </div>
      </main>

      {notice && <div className="toast" role="status"><span>✓</span>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
      {modal && modal !== 'user' && modal !== 'password' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-heading">
            <div><span className="eyebrow">INVENTORY</span><h2 id="modal-title">{modal === 'edit' ? 'Edit product' : modal === 'product' ? 'Add product' : modal === 'receive' ? 'Receive goods' : 'Adjust stock'}</h2></div>
            <button className="icon-button" onClick={() => setModal(null)} aria-label="Close dialog">×</button>
          </div>
          {modal === 'product' || modal === 'edit' ? <form action={(data) => submitProduct(data)}><label>Product name<input name="name" required defaultValue={editProduct?.name ?? ''} placeholder="e.g. Frozen chicken breast" /></label><div className="form-grid"><label>Category<input name="category" required defaultValue={editProduct?.category ?? ''} placeholder="e.g. Poultry" /></label><label>Stock unit<select name="unit" defaultValue={editProduct?.unit ?? 'carton'}><option>carton</option><option>piece</option><option>kg</option><option>pack</option><option>tub</option><option>bag</option></select></label><label>Carton cost<input name="cost" type="number" min="0" step="0.01" required defaultValue={editProduct?.cost ?? ''} placeholder="0.00" /></label><label>Carton price<input name="price" type="number" min="0" step="0.01" required defaultValue={editProduct?.price ?? ''} placeholder="600.00" /></label><label>Kilo price<input name="kiloPrice" type="number" min="0" step="0.01" required defaultValue={editProduct?.kiloPrice ?? editProduct?.price ?? ''} placeholder="35.00" /></label><label>Kilos per carton<input name="kgPerCarton" type="number" min="0.001" step="0.001" required defaultValue={editProduct?.kgPerCarton ?? 1} placeholder="18" /></label>{modal === 'product' && <label>Opening stock<input name="stock" type="number" min="0" step="0.001" defaultValue="0" /></label>}<label>Minimum stock level<input name="minimum" type="number" min="0" step="0.001" defaultValue={editProduct?.minimum ?? 0} /></label></div><ModalButtons onCancel={() => { setModal(null); setEditProduct(null) }} action={modal === 'edit' ? 'Save changes' : 'Save product'} /></form> : <form action={(data) => submitMovement(data, modal === 'receive' ? 'Goods received' : 'Adjustment')}><label>Product<select name="product" required>{products.map((product) => <option value={product.id} key={product.id}>{product.name} · {product.stock} {product.unit} in stock</option>)}</select></label><div className="form-grid"><label>{modal === 'receive' ? 'Quantity received' : 'Quantity to adjust'}<input name="quantity" type="number" min="0.001" step="0.001" required placeholder="0" /></label>{modal === 'receive' ? <label>Purchase cost per unit<input name="cost" type="number" min="0" step="0.01" required placeholder="0.00" /></label> : <label>Adjustment type<select name="direction"><option value="add">Add stock</option><option value="remove">Remove stock</option></select></label>}</div>{modal === 'receive' && <label>Supplier<input name="supplier" required placeholder="Supplier name" /></label>}{modal === 'adjust' && <label>Reason<input name="supplier" required placeholder="e.g. Damaged goods, stock count" /></label>}<ModalButtons onCancel={() => setModal(null)} action={modal === 'receive' ? 'Record delivery' : 'Save adjustment'} /></form>}
      </section></div>}
      {modal === 'user' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title"><div className="modal-heading"><div><span className="eyebrow">ACCESS CONTROL</span><h2 id="account-modal-title">Add store user</h2></div><button className="icon-button" onClick={() => setModal(null)} aria-label="Close dialog">×</button></div><form action={(data) => void submitUser(data)}><label>Full name<input name="name" required minLength={2} placeholder="Staff member name" /></label><label>Email address<input name="email" type="email" required placeholder="staff@yourstore.com" /></label><label>Temporary password<input name="password" type="password" minLength={10} required placeholder="At least 10 characters" /></label><label>Role<select name="role"><option value="attendant">Shop Attendant</option><option value="admin">Administrator</option></select></label><ModalButtons onCancel={() => setModal(null)} action="Create account" /></form></section></div>}
      {modal === 'password' && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null) }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="password-modal-title"><div className="modal-heading"><div><span className="eyebrow">ACCOUNT SECURITY</span><h2 id="password-modal-title">Change password</h2></div><button className="icon-button" onClick={() => setModal(null)} aria-label="Close dialog">×</button></div><form action={(data) => void submitPassword(data)}><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>New password<input name="newPassword" type="password" autoComplete="new-password" minLength={10} required placeholder="At least 10 characters" /></label><ModalButtons onCancel={() => setModal(null)} action="Update password" /></form><div className="account-signout"><span>{user?.email}</span><button className="row-action" onClick={signOut}>Sign out</button></div></section></div>}
    </div>
  )
}

function ProductTable({ products, canEdit, onEdit, onToggle }: { products: Product[], canEdit: boolean, onEdit: (product: Product) => void, onToggle: (id: number) => void }) {
  return <div className="table-scroll"><table><thead><tr><th>PRODUCT</th><th>CATEGORY</th><th>STOCK</th><th>CARTON COST</th><th>CARTON PRICE</th><th>KILO PRICE</th><th>STATUS</th>{canEdit && <th />}</tr></thead><tbody>{products.map((product) => <tr data-product-row key={product.id}><td><strong>{product.name}</strong><small className="cell-subtitle">{product.kgPerCarton} kg per carton</small></td><td>{product.category}</td><td><strong className={product.stock <= product.minimum ? 'warning-number' : ''}>{product.stock} {product.unit}</strong><small className="cell-subtitle">Min. {product.minimum}</small></td><td>{money(product.cost)}</td><td>{money(product.price)}</td><td>{money(product.kiloPrice)}</td><td><span className={`status-tag ${product.status === 'Active' ? 'status-active' : 'status-inactive'}`}>{product.status}</span></td>{canEdit && <td><button className="row-action" onClick={() => onEdit(product)}>Edit</button><button className="row-action" title="Toggle product status" onClick={() => onToggle(product.id)}>{product.status === 'Active' ? 'Disable' : 'Enable'}</button></td>}</tr>)}</tbody></table>{products.length === 0 && <div className="empty-state">No products yet. Add your first product to begin.</div>}</div>
}

function MovementTable({ movements }: { movements: Movement[] }) {
  return <div className="table-scroll"><table><thead><tr><th>PRODUCT</th><th>ACTIVITY</th><th>QUANTITY</th><th>SUPPLIER / NOTE</th><th>WHEN</th></tr></thead><tbody>{movements.map((movement) => <tr key={movement.id}><td><strong>{movement.product}</strong></td><td><span className={`movement-tag ${movement.kind === 'Goods received' ? 'received-tag' : 'adjusted-tag'}`}>{movement.kind}</span></td><td><strong className={movement.quantity > 0 ? 'positive' : 'negative'}>{movement.quantity > 0 ? '+' : ''}{movement.quantity}</strong></td><td>{movement.supplier}</td><td className="date-cell">{movement.date}</td></tr>)}</tbody></table>{movements.length === 0 && <div className="empty-state">Stock activity will appear here.</div>}</div>
}

function ModalButtons({ onCancel, action }: { onCancel: () => void, action: string }) {
  return <div className="modal-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" type="submit">{action}</button></div>
}

export default App
