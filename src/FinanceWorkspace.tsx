import { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { parseApiResponse } from './api.ts'
import './finance.css'

type Product = { id: number; name: string; category: string; unit: string; stock: number; minimum: number; cost: number; price: number; kiloPrice: number; kgPerCarton: number; status: 'Active' | 'Inactive' }
type SaleUnit = 'carton' | 'kg'
type SaleItem = { productId: number; productName: string; quantity: number; saleUnit: SaleUnit; stockQuantity: number; unitPrice: number; unitCost?: number; lineSubtotal?: number; lineDiscount?: number; lineTotal: number; lineProfit?: number }
type Sale = { id: number; receiptNumber: string; userId?: number; attendantName?: string; paymentMethod: 'cash' | 'momo' | 'other'; subtotal: number; discountAmount: number; totalAmount: number; amountPaid: number; changeDue: number; totalProfit: number; status: 'completed' | 'reversed'; reversalReason?: string; createdAt: string; items: SaleItem[] }
type ReceiptProfile = { businessName: string; businessAddress: string | null; businessPhone: string | null; businessEmail: string | null; logoUrl: string | null; receiptFooter: string; receiptQrEnabled: boolean; currencyCode: string; timeZone: string }
type FinanceTransaction = { id: number; type: 'sale' | 'income' | 'expense'; reference?: string; category?: string; description?: string; amount: number; paymentMethod: string; status?: string; voided?: boolean; userId?: number; attendantName?: string; createdAt: string }
type DailyTally = { total_sales: number; cash_sales: number; momo_sales: number; other_sales: number; other_income: number; cash_income: number; expenses: number; cash_expenses: number; sales_profit: number; expected_cash: number; closure: null | { actualCash: number; expectedCash: number; difference: number; closedAt: string } }
type AdjustmentRequest = { id: number; productId: number; productName: string; unit: string; quantity: number; reason: string; requestedBy: string; createdAt: string }
type Closure = { id: number; attendantName: string; businessDate: string; totalSales: number; expenses: number; expectedCash: number; actualCash: number; difference: number; closedAt: string }
type Props = { view: string; products: Product[]; token: string; preview: boolean; role: 'admin' | 'attendant'; userId: number; userName: string; onInventoryChanged: () => void; onPreviewSale: (items: SaleItem[]) => void; onPreviewReversal: (items: SaleItem[]) => void; onFinanceChanged: () => void; onNavigate: (view: string) => void; onNotice: (message: string) => void }
type DraftCorrection = { type: 'income' | 'expense'; id: number; category: string; description: string; amount: number; paymentMethod: string; reason: string }

const money = (value: number) => `GH₵ ${Math.abs(value).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const paymentLabel: Record<string, string> = { cash: 'Cash', momo: 'MoMo', other: 'Bank / other' }
const incomeCategories = [['delivery_charge', 'Delivery charges'], ['miscellaneous', 'Miscellaneous income'], ['other', 'Other income']]
const expenseCategories = [['electricity', 'Electricity'], ['water', 'Water'], ['transport', 'Transport'], ['fuel', 'Fuel'], ['repairs', 'Repairs'], ['maintenance', 'Maintenance'], ['salaries', 'Salaries'], ['rent', 'Rent'], ['packaging', 'Packaging'], ['other', 'Other expenses']]
const mockSales: Sale[] = []
const businessDateLabel = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(new Date())
const newPreviewTimestamp = () => new Date().toISOString()

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers } })
  return parseApiResponse<T>(response)
}

export default function FinanceWorkspace({ view, products, token, preview, role, userId, userName, onInventoryChanged, onPreviewSale, onPreviewReversal, onFinanceChanged, onNavigate, onNotice }: Props) {
  const [sales, setSales] = useState<Sale[]>(mockSales)
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([])
  const [tally, setTally] = useState<DailyTally>({ total_sales: 0, cash_sales: 0, momo_sales: 0, other_sales: 0, other_income: 0, cash_income: 0, expenses: 0, cash_expenses: 0, sales_profit: 0, expected_cash: 0, closure: null })
  const [closures, setClosures] = useState<Closure[]>([])
  const [requests, setRequests] = useState<AdjustmentRequest[]>([])
  const [cart, setCart] = useState<SaleItem[]>([])
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [saleUnit, setSaleUnit] = useState<SaleUnit>('carton')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'momo' | 'other'>('cash')
  const [discountAmount, setDiscountAmount] = useState('0')
  const [amountPaid, setAmountPaid] = useState('')
  const [entryType, setEntryType] = useState<'income' | 'expense'>('expense')
  const [actualCash, setActualCash] = useState('')
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [receiptProfile, setReceiptProfile] = useState<ReceiptProfile>({ businessName: "Gosh Cold Store", businessAddress: null, businessPhone: null, businessEmail: null, logoUrl: null, receiptFooter: 'Thank you for shopping with us.', receiptQrEnabled: false, currencyCode: 'GHS', timeZone: 'Africa/Accra' })
  const [receiptSearch, setReceiptSearch] = useState('')
  const [receiptFrom, setReceiptFrom] = useState('')
  const [receiptTo, setReceiptTo] = useState('')
  const [receiptResults, setReceiptResults] = useState<Array<{ id: number; receiptNumber: string; paymentMethod: Sale['paymentMethod']; subtotal: number; discountAmount: number; totalAmount: number; amountPaid: number; changeDue: number; status: Sale['status']; userId: number; attendantName: string; createdAt: string }>>([])
  const [paperWidth, setPaperWidth] = useState<'58' | '80' | 'normal'>('80')
  const [receiptQr, setReceiptQr] = useState('')
  const [correction, setCorrection] = useState<DraftCorrection | null>(null)
  const [reversal, setReversal] = useState<{ id: number; receiptNumber: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [previewTransactions, setPreviewTransactions] = useState<FinanceTransaction[]>([])
  const previewSequence = useRef(0)

  const currentRole = role === 'admin' ? 'Admin' : 'Shop Attendant'
  const activeProducts = products.filter((item) => item.status === 'Active' && item.stock > 0)
  const cartTotal = cart.reduce((sum, item) => sum + item.lineTotal, 0)
  const discountValue = Math.max(0, Number(discountAmount) || 0)
  const totalDue = Math.max(0, Math.round((cartTotal - discountValue + Number.EPSILON) * 100) / 100)
  const paidValue = amountPaid === '' ? totalDue : Math.max(0, Number(amountPaid) || 0)
  const changeValue = Math.max(0, Math.round((paidValue - totalDue + Number.EPSILON) * 100) / 100)
  const cartProfit = cart.reduce((sum, item) => sum + (item.lineProfit ?? 0), 0)
  const displayedTransactions = preview ? previewTransactions : transactions
  const daily = useMemo(() => preview ? previewTransactions.reduce((summary, transaction) => {
    if (transaction.voided || transaction.status === 'reversed') return summary
    const amount = transaction.amount
    if (transaction.type === 'sale') {
      summary.total_sales += amount
      if (transaction.paymentMethod === 'cash') summary.cash_sales += amount
      else if (transaction.paymentMethod === 'momo') summary.momo_sales += amount
      else summary.other_sales += amount
    } else if (transaction.type === 'income') {
      summary.other_income += amount
      if (transaction.paymentMethod === 'cash') summary.cash_income += amount
    } else {
      summary.expenses += amount
      if (transaction.paymentMethod === 'cash') summary.cash_expenses += amount
    }
    if (transaction.type === 'sale') summary.sales_profit += (sales.find((sale) => sale.id === transaction.id)?.totalProfit ?? 0)
    return summary
  }, { ...tally, total_sales: 0, cash_sales: 0, momo_sales: 0, other_sales: 0, other_income: 0, cash_income: 0, expenses: 0, cash_expenses: 0, sales_profit: 0 }) : tally, [preview, previewTransactions, tally, sales])
  const expectedCash = Math.round((daily.cash_sales + daily.cash_income - daily.cash_expenses + Number.EPSILON) * 100) / 100

  async function refresh() {
    if (preview || !token) return
    const results = await Promise.all([
      api<{ sales: Sale[] }>('/api/sales', token),
      api<DailyTally>('/api/finance/daily', token),
      api<{ transactions: FinanceTransaction[] }>('/api/finance/transactions', token),
      role === 'admin' ? api<{ closures: Closure[] }>('/api/finance/closures', token) : Promise.resolve({ closures: [] as Closure[] }),
      api<{ requests: AdjustmentRequest[] }>('/api/stock/adjustment-requests', token),
    ])
    setSales(results[0].sales.map((sale) => ({ ...sale, subtotal: Number(sale.subtotal), discountAmount: Number(sale.discountAmount), totalAmount: Number(sale.totalAmount), amountPaid: Number(sale.amountPaid), changeDue: Number(sale.changeDue), totalProfit: Number(sale.totalProfit), items: sale.items.map((item) => ({ ...item, saleUnit: item.saleUnit ?? 'carton', quantity: Number(item.quantity), stockQuantity: Number(item.stockQuantity ?? item.quantity), unitPrice: Number(item.unitPrice), lineSubtotal: Number(item.lineSubtotal), lineDiscount: Number(item.lineDiscount), lineTotal: Number(item.lineTotal), lineProfit: Number(item.lineProfit ?? 0) })) })))
    const parsedTally = Object.fromEntries(Object.entries(results[1]).map(([key, value]) => [key, typeof value === 'string' && key !== 'businessDate' ? Number(value) : value])) as DailyTally
    if (parsedTally.closure) parsedTally.closure = { ...parsedTally.closure, actualCash: Number(parsedTally.closure.actualCash), expectedCash: Number(parsedTally.closure.expectedCash), difference: Number(parsedTally.closure.difference) }
    setTally(parsedTally)
    setTransactions(results[2].transactions.map((item) => ({ ...item, amount: Number(item.amount) })))
    setClosures(results[3].closures.map((item) => ({ ...item, totalSales: Number(item.totalSales), expenses: Number(item.expenses), expectedCash: Number(item.expectedCash), actualCash: Number(item.actualCash), difference: Number(item.difference) })))
    setRequests(results[4].requests.map((item) => ({ ...item, quantity: Number(item.quantity) })))
  }

  const synchronizeFinance = useEffectEvent(() => {
    if (!preview && token && ['Sales', 'Finance', 'Transactions', 'Approvals'].includes(view)) {
      void refresh().catch((error: unknown) => startTransition(() => setProblem(error instanceof Error ? error.message : 'Unable to load finance data')))
    }
  })

  const synchronizeReceiptSearch = useEffectEvent(() => {
    if (view === 'Receipts') {
      void searchReceipts().catch((error: unknown) => startTransition(() => setProblem(error instanceof Error ? error.message : 'Unable to search receipts')))
    }
  })

  async function searchReceipts() {
    if (preview) {
      setReceiptResults(sales.filter((sale) => sale.receiptNumber.toLowerCase().includes(receiptSearch.toLowerCase()) && (!receiptFrom || sale.createdAt.slice(0, 10) >= receiptFrom) && (!receiptTo || sale.createdAt.slice(0, 10) <= receiptTo)).map(({ items: _items, totalProfit: _profit, ...sale }) => sale as typeof receiptResults[number]))
      return
    }
    const params = new URLSearchParams()
    if (receiptSearch) params.set('q', receiptSearch)
    if (receiptFrom) params.set('from', receiptFrom)
    if (receiptTo) params.set('to', receiptTo)
    const result = await api<{ receipts: typeof receiptResults }>(`/api/receipts?${params}`, token)
    setReceiptResults(result.receipts)
  }

  async function openReceipt(id: number) {
    if (preview) {
      const sample = sales.find((sale) => sale.id === id)
      if (sample) setReceipt(sample)
    } else {
      const result = await api<{ receipt: Sale & ReceiptProfile }>(`/api/receipts/${id}`, token)
      const record = result.receipt
      setReceiptProfile({ businessName: record.businessName, businessAddress: record.businessAddress, businessPhone: record.businessPhone, businessEmail: record.businessEmail, logoUrl: record.logoUrl, receiptFooter: record.receiptFooter, receiptQrEnabled: record.receiptQrEnabled, currencyCode: record.currencyCode, timeZone: record.timeZone })
      setReceipt({ ...record, subtotal: Number(record.subtotal), discountAmount: Number(record.discountAmount), totalAmount: Number(record.totalAmount), amountPaid: Number(record.amountPaid), changeDue: Number(record.changeDue), totalProfit: Number(record.totalProfit), items: record.items.map((item) => ({ ...item, saleUnit: item.saleUnit ?? 'carton', quantity: Number(item.quantity), stockQuantity: Number(item.stockQuantity ?? item.quantity), unitPrice: Number(item.unitPrice), lineSubtotal: Number(item.lineSubtotal), lineDiscount: Number(item.lineDiscount), lineTotal: Number(item.lineTotal) })) })
    }
    onNavigate('Receipt')
  }

  async function saveReceiptProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const payload = { businessName: String(form.get('businessName')), businessAddress: String(form.get('businessAddress')) || null, businessPhone: String(form.get('businessPhone')) || null, businessEmail: String(form.get('businessEmail')) || null, logoUrl: String(form.get('logoUrl')) || null, receiptFooter: String(form.get('receiptFooter')), receiptQrEnabled: form.get('receiptQrEnabled') === 'on' }
    try {
      const result = await api<{ profile: ReceiptProfile }>('/api/business-profile', token, { method: 'PATCH', body: JSON.stringify(payload) })
      setReceiptProfile(result.profile)
      onNotice('Receipt business details saved')
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Unable to save receipt settings') }
  }

  async function downloadReceiptPdf() {
    if (!receipt) return
    const { default: JsPDF } = await import('jspdf')
    const isThermal = paperWidth !== 'normal'
    const width = paperWidth === '58' ? 58 : paperWidth === '80' ? 80 : 210
    const margin = paperWidth === 'normal' ? 18 : 4
    const bodyWidth = width - margin * 2
    const fontSize = paperWidth === '58' ? 8 : paperWidth === '80' ? 9 : 11
    const lineHeight = fontSize * 0.55
    const pageHeight = isThermal ? Math.max(140, 125 + receipt.items.length * 14 + (receiptProfile.logoUrl ? 18 : 0)) : 297
    const pdf = new JsPDF({ orientation: 'portrait', unit: 'mm', format: isThermal ? [width, pageHeight] : 'a4' })
    let y = 12
    if (receiptProfile.logoUrl) {
      try {
        const imageResponse = await fetch(receiptProfile.logoUrl)
        const imageBlob = await imageResponse.blob()
        const imageData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid logo image'))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(imageBlob)
        })
        const imageType = imageBlob.type.includes('png') ? 'PNG' : 'JPEG'
        pdf.addImage(imageData, imageType, width / 2 - 8, y, 16, 16)
        y += 19
      } catch { /* Receipt text remains downloadable when a remote logo blocks embedding. */ }
    }
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(fontSize + 3)
    pdf.text(receiptProfile.businessName, width / 2, y, { align: 'center', maxWidth: bodyWidth })
    y += lineHeight + 2
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(fontSize - 1)
    for (const line of [receiptProfile.businessAddress, receiptProfile.businessPhone, receiptProfile.businessEmail].filter(Boolean)) {
      pdf.text(String(line), width / 2, y, { align: 'center', maxWidth: bodyWidth })
      y += lineHeight
    }
    y += 2
    pdf.text(`Receipt: ${receipt.receiptNumber}`, margin, y); y += lineHeight
    pdf.text(new Date(receipt.createdAt).toLocaleString(), margin, y); y += lineHeight
    pdf.text(`Attendant: ${receipt.attendantName || userName}`, margin, y); y += lineHeight
    pdf.text(`Payment: ${paymentLabel[receipt.paymentMethod]}`, margin, y); y += lineHeight + 2
    pdf.setDrawColor(150)
    pdf.line(margin, y, width - margin, y); y += lineHeight + 1
    pdf.setFont('helvetica', 'bold')
    pdf.text('ITEM', margin, y)
    pdf.text('TOTAL', width - margin, y, { align: 'right' }); y += lineHeight + 1
    pdf.setFont('helvetica', 'normal')
    for (const item of receipt.items) {
      if (!isThermal && y > 265) { pdf.addPage(); y = 18 }
      const nameLines = pdf.splitTextToSize(item.productName, bodyWidth * 0.62) as string[]
      pdf.text(nameLines, margin, y)
      pdf.text(money(item.lineTotal), width - margin, y, { align: 'right' })
      y += Math.max(nameLines.length, 1) * lineHeight
      pdf.setFontSize(fontSize - 1)
      pdf.text(`${item.quantity} ${item.saleUnit} x ${money(item.unitPrice)}`, margin, y)
      y += lineHeight + 1
      pdf.setFontSize(fontSize)
    }
    pdf.line(margin, y, width - margin, y); y += lineHeight + 1
    const totals: Array<[string, number]> = [['Subtotal', receipt.subtotal], ['Discount', -receipt.discountAmount], ['Total', receipt.totalAmount], ['Amount paid', receipt.amountPaid], ['Change', receipt.changeDue]]
    for (const [label, value] of totals) {
      if (label === 'Discount' && value === 0) continue
      pdf.setFont('helvetica', label === 'Total' ? 'bold' : 'normal')
      pdf.text(label, margin, y)
      pdf.text(`${value < 0 ? '-' : ''}${money(value)}`, width - margin, y, { align: 'right' })
      y += lineHeight + 1
    }
    y += 4
    pdf.setFont('helvetica', 'normal')
    pdf.text(receiptProfile.receiptFooter || 'Thank you for shopping with us.', width / 2, y, { align: 'center', maxWidth: bodyWidth })
    if (receiptProfile.receiptQrEnabled) {
      const QRCode = await import('qrcode')
      const qrData = await QRCode.toDataURL(`Receipt ${receipt.receiptNumber} | Total ${receipt.totalAmount} ${receiptProfile.currencyCode}`, { width: 180, margin: 1 })
      y += lineHeight + 3
      pdf.addImage(qrData, 'PNG', width / 2 - 10, y, 20, 20)
    }
    pdf.save(`${receipt.receiptNumber}.pdf`)
    onNotice(`Receipt PDF generated · ${receipt.receiptNumber}.pdf`)
  }

  useEffect(() => {
    const timer = window.setTimeout(synchronizeFinance, 0)
    return () => window.clearTimeout(timer)
  }, [token, preview, role, view])

  useEffect(() => {
    if (preview || !token) return
    void api<{ profile: ReceiptProfile }>('/api/business-profile', token).then((result) => setReceiptProfile(result.profile)).catch(() => undefined)
  }, [token, preview])

  useEffect(() => {
    if (view !== 'Receipts') return
    const timer = window.setTimeout(synchronizeReceiptSearch, 0)
    return () => window.clearTimeout(timer)
  }, [view, token, preview])

  useEffect(() => {
    if (!receipt || !receiptProfile.receiptQrEnabled) {
      const timer = window.setTimeout(() => setReceiptQr(''), 0)
      return () => window.clearTimeout(timer)
    }
    void import('qrcode').then((QRCode) => QRCode.toDataURL(`Receipt ${receipt.receiptNumber} | Total ${receipt.totalAmount} ${receiptProfile.currencyCode}`, { width: 180, margin: 1 })).then(setReceiptQr).catch(() => setReceiptQr(''))
  }, [receipt, receiptProfile.receiptQrEnabled, receiptProfile.currencyCode])

  function addCartItem() {
    const product = activeProducts.find((item) => item.id === Number(productId))
    const quantityValue = Number(quantity)
    if (!product || !Number.isFinite(quantityValue) || quantityValue <= 0) return setProblem('Select a product and enter a valid quantity.')
    const kgPerCarton = product.kgPerCarton || 1
    const stockQuantity = saleUnit === 'kg' ? Math.round((quantityValue / kgPerCarton + Number.EPSILON) * 1000) / 1000 : quantityValue
    const alreadyInCart = cart.filter((item) => item.productId === product.id).reduce((sum, item) => sum + item.stockQuantity, 0)
    if (alreadyInCart + stockQuantity > product.stock) return setProblem(`Only ${Math.max(0, product.stock - alreadyInCart)} ${product.unit} available.`)
    const unitPrice = saleUnit === 'kg' ? product.kiloPrice : product.price
    const unitCost = saleUnit === 'kg' ? Math.round((product.cost / kgPerCarton + Number.EPSILON) * 100) / 100 : product.cost
    const lineTotal = Math.round((unitPrice * quantityValue + Number.EPSILON) * 100) / 100
    const lineProfit = Math.round(((unitPrice - unitCost) * quantityValue + Number.EPSILON) * 100) / 100
    setCart((items) => [...items, { productId: product.id, productName: product.name, quantity: quantityValue, saleUnit, stockQuantity, unitPrice, unitCost, lineTotal, lineProfit }])
    setProblem('')
  }

  async function completeSale() {
    if (!cart.length) return setProblem('Add at least one product to the sale.')
    if (discountValue > cartTotal) return setProblem('Discount cannot exceed the sale subtotal.')
    if (paidValue < totalDue) return setProblem('Amount paid cannot be less than the total due.')
    setBusy(true)
    setProblem('')
    try {
        let sale: Sale;
      if (preview) {
        const id = ++previewSequence.current
          let allocated = 0
          const items = cart.map((item, index) => {
            const lineSubtotal = item.lineTotal
            const lineDiscount = index === cart.length - 1 ? discountValue - allocated : cartTotal ? Math.round(discountValue * lineSubtotal / cartTotal * 100) / 100 : 0
            allocated = Math.round((allocated + lineDiscount) * 100) / 100
            const lineTotal = Math.round((lineSubtotal - lineDiscount) * 100) / 100
            return { ...item, lineSubtotal, lineDiscount, lineTotal, lineProfit: Math.round((lineTotal - (item.unitCost ?? 0) * item.quantity) * 100) / 100 }
          })
          sale = { id, receiptNumber: `PREVIEW-${String(id).padStart(6, '0')}`, userId, attendantName: userName, paymentMethod, subtotal: cartTotal, discountAmount: discountValue, totalAmount: totalDue, amountPaid: paidValue, changeDue: changeValue, totalProfit: items.reduce((sum, item) => sum + (item.lineProfit ?? 0), 0), status: 'completed', createdAt: newPreviewTimestamp(), items }
        onPreviewSale(sale.items)
          const transaction: FinanceTransaction = { id, type: 'sale', reference: sale.receiptNumber, amount: sale.totalAmount, paymentMethod, status: 'completed', userId, attendantName: userName, createdAt: sale.createdAt }
        setPreviewTransactions((items) => [transaction, ...items])
        setSales((items) => [sale, ...items])
        onFinanceChanged()
      } else {
          const result = await api<{ sale: Sale }>('/api/sales', token, { method: 'POST', body: JSON.stringify({ paymentMethod, discountAmount: discountValue, amountPaid: paidValue, items: cart.map(({ productId: id, quantity: count, saleUnit: unit }) => ({ productId: id, quantity: count, saleUnit: unit })) }) });
        sale = { ...result.sale, userId, attendantName: userName }
        await refresh()
        onInventoryChanged()
      }
      setReceipt(sale)
      setDiscountAmount('0')
      setAmountPaid('')
      setCart([])
      onNavigate('Receipt')
      onNotice(`Sale completed · ${sale.receiptNumber}`)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to complete sale')
    } finally {
      setBusy(false)
    }
  }

  async function recordFinanceEntry(event: FormEvent<HTMLFormElement>, type: 'income' | 'expense') {
    event.preventDefault()
    const targetForm = event.currentTarget
    const form = new FormData(targetForm)
    const payload = { category: String(form.get('category')), description: String(form.get('description')), amount: Number(form.get('amount')), paymentMethod: String(form.get('paymentMethod')) }
    setBusy(true)
    setProblem('')
    try {
      if (preview) {
        const entry: FinanceTransaction = { id: ++previewSequence.current, type, ...payload, createdAt: newPreviewTimestamp(), userId, attendantName: userName }
        setPreviewTransactions((items) => [entry, ...items])
      } else {
        await api(type === 'income' ? '/api/income' : '/api/expenses', token, { method: 'POST', body: JSON.stringify(payload) })
        await refresh()
      }
      onFinanceChanged()
      targetForm.reset()
      setEntryType('expense')
      onNotice(`${type === 'income' ? 'Income' : 'Expense'} recorded`)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to record entry')
    } finally {
      setBusy(false)
    }
  }

  async function closeDay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    try {
      const amount = Number(actualCash)
      if (preview) {
        setTally((value) => ({ ...value, closure: { actualCash: amount, expectedCash, difference: Math.round((amount - expectedCash) * 100) / 100, closedAt: new Date().toISOString() } }))
      } else {
        await api('/api/finance/close', token, { method: 'POST', body: JSON.stringify({ actualCash: amount }) })
        await refresh()
      }
      onFinanceChanged()
      onNotice('Cash day closed')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to close day')
    } finally {
      setBusy(false)
    }
  }

  async function reopenDay() {
    setBusy(true)
    setProblem('')
    try {
      if (preview) {
        setTally((value) => ({ ...value, closure: null }))
      } else {
        await api('/api/finance/reopen', token, { method: 'POST', body: JSON.stringify({ userId }) })
        await refresh()
      }
      onFinanceChanged()
      onNotice('Cash day reopened')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to reopen day')
    } finally {
      setBusy(false)
    }
  }

  async function reverseSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reversal) return
    const reason = String(new FormData(event.currentTarget).get('reason'))
    setBusy(true)
    try {
      const sale = sales.find((item) => item.id === reversal.id)
      if (preview && sale) {
        onPreviewReversal(sale.items)
        setSales((current) => current.map((item) => item.id === sale.id ? { ...item, status: 'reversed', reversalReason: reason } : item))
        setPreviewTransactions((current) => current.map((item) => item.id === sale.id ? { ...item, status: 'reversed' } : item))
      } else await api(`/api/sales/${reversal.id}/reverse`, token, { method: 'POST', body: JSON.stringify({ reason }) })
      setReversal(null)
      if (!preview) { await refresh(); onInventoryChanged() }
      onFinanceChanged()
      onNotice(`Sale ${reversal.receiptNumber} reversed; stock restored`)
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Unable to reverse sale') } finally { setBusy(false) }
  }

  async function correctTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!correction) return
    const form = new FormData(event.currentTarget)
    const body = { category: String(form.get('category')), description: String(form.get('description')), amount: Number(form.get('amount')), paymentMethod: String(form.get('paymentMethod')), reason: String(form.get('reason')) }
    setBusy(true)
    try {
      if (preview) {
        setPreviewTransactions((current) => current.map((item) => item.id === correction.id ? { ...item, category: body.category, description: body.description, amount: body.amount, paymentMethod: body.paymentMethod } : item))
      } else await api(`/api/finance/${correction.type}/${correction.id}`, token, { method: 'PATCH', body: JSON.stringify(body) })
      setCorrection(null)
      if (!preview) await refresh()
      onFinanceChanged()
      onNotice('Transaction correction saved to audit log')
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Unable to correct transaction') } finally { setBusy(false) }
  }

  async function voidTransaction(transaction: FinanceTransaction) {
    const reason = window.prompt(`Reason for voiding ${transaction.type} ${transaction.id}:`)
    if (!reason?.trim()) return
    setBusy(true)
    try {
      if (preview) setPreviewTransactions((current) => current.map((item) => item.id === transaction.id ? { ...item, voided: true } : item))
      else { await api(`/api/finance/${transaction.type}/${transaction.id}/void`, token, { method: 'POST', body: JSON.stringify({ reason }) }); await refresh() }
      onFinanceChanged()
      onNotice('Transaction voided and recorded in audit log')
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Unable to void transaction') } finally { setBusy(false) }
  }

  async function reverseApproval(request: AdjustmentRequest, decision: 'approved' | 'rejected') {
    setBusy(true)
    try {
      await api(`/api/stock/adjustment-requests/${request.id}`, token, { method: 'PATCH', body: JSON.stringify({ decision }) })
      await refresh()
      if (decision === 'approved') onInventoryChanged()
      onNotice(`Adjustment request ${decision}`)
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Unable to review adjustment') } finally { setBusy(false) }
  }

  const recentSales = sales
  const closed = Boolean(tally.closure)
  const categories = correction?.type === 'income' ? incomeCategories : expenseCategories
  if (!['Sales', 'Finance', 'Transactions', 'Approvals', 'Receipts', 'Receipt'].includes(view)) return null

  return <div className="finance-workspace">
    {problem && <div className="finance-error" role="alert">{problem}<button onClick={() => setProblem('')} aria-label="Dismiss error">×</button></div>}

    {view === 'Sales' && <>
      <div className="finance-heading"><div><h2>New sale</h2><p>Prices come from the active product catalogue. Stock updates when the sale is completed.</p></div><span className={`day-state ${closed ? 'day-closed' : 'day-open'}`}>{closed ? 'Day closed' : 'Register open'}</span></div>
      <div className="sales-layout"><section className="finance-panel sale-builder"><div className="finance-section-title"><h3>Add items</h3><span>{activeProducts.length} products available</span></div><div className="cart-entry"><label>Product<select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Choose product</option>{activeProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.stock} {product.unit} · carton {money(product.price)} · kg {money(product.kiloPrice)}</option>)}</select></label><label>Size<select value={saleUnit} onChange={(event) => setSaleUnit(event.target.value as SaleUnit)}><option value="carton">Carton</option><option value="kg">Kilo</option></select></label><label>Qty<input type="number" min="0.001" step="0.001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button className="button button-primary" onClick={addCartItem} disabled={closed}>Add item</button></div><div className="cart-list">{cart.length ? cart.map((item, index) => <div className="cart-row" key={`${item.productId}-${index}`}><div><strong>{item.productName}</strong><small>{item.quantity} {item.saleUnit} x {money(item.unitPrice)}</small></div><strong>{money(item.lineTotal)}</strong><button className="icon-action" onClick={() => setCart((current) => current.filter((_, row) => row !== index))} aria-label={`Remove ${item.productName}`}>×</button></div>) : <div className="finance-empty">Your sale is empty. Add a product to start.</div>}</div><div className="payment-selector"><span>Payment method</span><div role="group" aria-label="Payment method">{(['cash', 'momo', 'other'] as const).map((method) => <button key={method} className={paymentMethod === method ? 'payment-selected' : ''} onClick={() => setPaymentMethod(method)}>{paymentLabel[method]}</button>)}</div></div></section>
      <aside className="finance-panel sale-total"><span className="eyebrow">SALE SUMMARY</span><div className="summary-line"><span>Items</span><strong>{cart.reduce((sum, item) => sum + item.quantity, 0)}</strong></div><div className="summary-line"><span>Subtotal</span><strong>{money(cartTotal)}</strong></div><label className="sale-discount">Discount<input type="number" min="0" max={cartTotal} step="0.01" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} /></label><div className="sale-grand-total"><span>Total due</span><strong>{money(totalDue)}</strong></div><label className="sale-discount">Amount paid<input type="number" min={totalDue} step="0.01" value={amountPaid === '' ? totalDue.toFixed(2) : amountPaid} onChange={(event) => setAmountPaid(event.target.value)} /></label><div className="summary-line"><span>Change</span><strong>{money(changeValue)}</strong></div><div className="summary-line"><span>Estimated profit</span><strong className="profit-value">{money(cartProfit - discountValue)}</strong></div><button className="button button-primary complete-sale" onClick={() => void completeSale()} disabled={busy || closed || !cart.length}>{busy ? 'Processing…' : closed ? 'Register closed' : 'Complete sale'}</button></aside></div>
      <section className="finance-panel finance-table-panel"><div className="finance-section-title"><div><h3>Recent sales</h3><span>Latest completed and reversed receipts</span></div><button className="text-button" onClick={() => onNavigate('Receipts')}>Find receipt →</button></div><SalesTable sales={recentSales.slice(0, 10)} admin={role === 'admin'} onReceipt={(sale) => void openReceipt(sale.id)} onReverse={(sale) => setReversal({ id: sale.id, receiptNumber: sale.receiptNumber, reason: '' })} /></section>
    </>}
    {view === 'Finance' && <>
      <div className="finance-heading"><div><h2>Daily cash tally</h2><p>{businessDateLabel} · {currentRole}</p></div><span className={`day-state ${closed ? 'day-closed' : 'day-open'}`}>{closed ? 'Day closed' : 'Register open'}</span></div>
      <div className="tally-layout"><section className="finance-panel tally-panel"><div className="tally-total"><span>Total sales</span><strong>{money(daily.total_sales)}</strong></div><div className="tally-row"><span>Cash sales</span><strong>{money(daily.cash_sales)}</strong></div><div className="tally-row"><span>MoMo sales</span><strong>{money(daily.momo_sales)}</strong></div><div className="tally-row"><span>Bank / other sales</span><strong>{money(daily.other_sales)}</strong></div><div className="tally-row"><span>Other income</span><strong>{money(daily.other_income)}</strong></div><div className="tally-row"><span>Expenses</span><strong className="expense-value">− {money(daily.expenses)}</strong></div><div className="expected-cash"><div><span>Expected cash</span><strong>{money(expectedCash)}</strong></div><small>Cash sales + cash income − cash expenses</small></div>{closed ? <div className="closure-result"><div><span>Actual cash</span><strong>{money(tally.closure!.actualCash)}</strong></div><div><span>Difference</span><strong className={tally.closure!.difference < 0 ? 'expense-value' : 'profit-value'}>{tally.closure!.difference < 0 ? '− ' : tally.closure!.difference > 0 ? '+ ' : ''}{money(tally.closure!.difference)}</strong></div><small>Closed {new Date(tally.closure!.closedAt).toLocaleTimeString()}</small><button className="button button-secondary" type="button" onClick={() => void reopenDay()} disabled={busy}>{busy ? 'Reopening…' : 'Reopen day'}</button></div> : <form className="close-form" onSubmit={(event) => void closeDay(event)}><label>Actual cash counted<input type="number" min="0" step="0.01" required value={actualCash} onChange={(event) => setActualCash(event.target.value)} placeholder="Enter cash in till" /></label><button className="button button-primary" disabled={busy}>{busy ? 'Closing…' : 'Close business day'}</button></form>}</section>
      <section className="finance-panel entry-panel"><div className="finance-section-title"><div><h3>Record income or expense</h3><span>Include the payment method to reconcile cash</span></div></div><form className="finance-entry-form" onSubmit={(event) => void recordFinanceEntry(event, entryType)}><label>Entry type<select name="entryType" value={entryType} onChange={(event) => setEntryType(event.target.value as 'income' | 'expense')}><option value="expense">Expense</option><option value="income">Other income</option></select></label><label>Category<select name="category">{(entryType === 'income' ? incomeCategories : expenseCategories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Description<input name="description" required minLength={2} placeholder="What was this for?" /></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></label><label>Paid via<select name="paymentMethod"><option value="cash">Cash</option><option value="momo">MoMo</option><option value="other">Bank / other</option></select></label><button className="button button-primary" disabled={busy || closed}>{closed ? 'Day closed' : 'Record entry'}</button></form>
      </section></div>
      <section className="finance-panel finance-table-panel"><div className="finance-section-title"><div><h3>Today's activity</h3><span>Income and expenses recorded by the store team</span></div></div><TransactionTable transactions={displayedTransactions.filter((item) => item.type !== 'sale').slice(0, 12)} userId={userId} /></section>
      {role === 'admin' && <section className="finance-panel finance-table-panel"><div className="finance-section-title"><div><h3>Cash differences</h3><span>Attendant closeouts with shortages or excesses</span></div></div><ClosureTable closures={closures} /></section>}
    </>}
    {view === 'Transactions' && <section className="finance-panel finance-table-panel"><div className="finance-heading"><div><h2>All transactions</h2><p>Sales can be reversed; income and expenses can be corrected or voided with an audit reason.</p></div></div><TransactionTable transactions={displayedTransactions} admin={role === 'admin'} userId={userId} onReceipt={(transaction) => { const sale = sales.find((item) => item.id === transaction.id); if (sale) void openReceipt(sale.id) }} onReverse={(transaction) => setReversal({ id: transaction.id, receiptNumber: transaction.reference || `Sale ${transaction.id}`, reason: '' })} onCorrect={(transaction) => transaction.type !== 'sale' && setCorrection({ type: transaction.type, id: transaction.id, category: transaction.category || 'other', description: transaction.description || '', amount: transaction.amount, paymentMethod: transaction.paymentMethod, reason: '' })} onVoid={(transaction) => void voidTransaction(transaction)} /></section>}
    {view === 'Approvals' && <section className="finance-panel finance-table-panel"><div className="finance-heading"><div><h2>Stock adjustment requests</h2><p>Attendant requests do not change stock until approved.</p></div><span className="approval-count">{requests.length} pending</span></div>{requests.length === 0 ? <div className="finance-empty">No adjustments are waiting for approval.</div> : <div className="approval-list">{requests.map((request) => <div className="approval-row" key={request.id}><div className="approval-main"><strong>{request.productName}</strong><span className={request.quantity > 0 ? 'profit-value' : 'expense-value'}>{request.quantity > 0 ? '+' : ''}{request.quantity} {request.unit}</span><p>{request.reason}</p><small>Requested by {request.requestedBy} · {new Date(request.createdAt).toLocaleString()}</small></div><div className="approval-actions"><button className="button button-secondary" disabled={busy} onClick={() => void reverseApproval(request, 'rejected')}>Reject</button><button className="button button-primary" disabled={busy} onClick={() => void reverseApproval(request, 'approved')}>Approve</button></div></div>)}</div>}</section>}
    {view === 'Receipts' && <section className="receipt-search-page"><div className="finance-heading"><div><h2>Receipt archive</h2><p>Search by receipt number or business date and reprint any available receipt.</p></div><button className="button button-primary" onClick={() => onNavigate('Sales')}>New sale</button></div><form className="receipt-search-bar" onSubmit={(event) => { event.preventDefault(); void searchReceipts() }}><label>Receipt number<input value={receiptSearch} onChange={(event) => setReceiptSearch(event.target.value)} placeholder="e.g. FS-20261003-000231" /></label><label>From<input type="date" value={receiptFrom} onChange={(event) => setReceiptFrom(event.target.value)} /></label><label>To<input type="date" value={receiptTo} onChange={(event) => setReceiptTo(event.target.value)} /></label><button className="button button-secondary" type="submit">Search receipts</button></form>{role === 'admin' && !preview && <details className="finance-panel receipt-settings"><summary>Receipt business details</summary><form onSubmit={(event) => void saveReceiptProfile(event)}><label>Business name<input name="businessName" required defaultValue={receiptProfile.businessName} /></label><label>Address<input name="businessAddress" defaultValue={receiptProfile.businessAddress ?? ''} /></label><label>Phone<input name="businessPhone" defaultValue={receiptProfile.businessPhone ?? ''} /></label><label>Email<input name="businessEmail" type="email" defaultValue={receiptProfile.businessEmail ?? ''} /></label><label>Logo URL<input name="logoUrl" type="url" defaultValue={receiptProfile.logoUrl ?? ''} /></label><label>Footer<input name="receiptFooter" defaultValue={receiptProfile.receiptFooter} /></label><label className="receipt-qr-setting"><input name="receiptQrEnabled" type="checkbox" defaultChecked={receiptProfile.receiptQrEnabled} /> Show receipt QR</label><button className="button button-primary">Save receipt details</button></form></details>}<section className="finance-panel finance-table-panel"><ReceiptTable receipts={receiptResults} onOpen={(id) => void openReceipt(id)} /></section></section>}
    {view === 'Receipt' && receipt && <section className="dedicated-receipt-page"><div className="receipt-page-toolbar"><button className="button button-secondary" onClick={() => onNavigate('Receipts')}>← Receipt archive</button><div className="receipt-toolbar-actions"><label>Paper<select value={paperWidth} onChange={(event) => setPaperWidth(event.target.value as typeof paperWidth)}><option value="58">58 mm POS</option><option value="80">80 mm POS</option><option value="normal">A4 / normal printer</option></select></label><button className="button button-secondary" onClick={() => window.print()}>Print receipt</button><button className="button button-primary" onClick={() => void downloadReceiptPdf().catch((error: unknown) => setProblem(error instanceof Error ? error.message : 'Unable to generate PDF'))}>Download PDF</button></div></div><article className={`receipt-sheet receipt-width-${paperWidth}`}><div className="receipt-brand">{receiptProfile.logoUrl ? <img className="receipt-logo" src={receiptProfile.logoUrl} alt="Business logo" /> : <span className="brand-mark">F</span>}<div><strong>{receiptProfile.businessName}</strong>{receiptProfile.businessAddress && <small>{receiptProfile.businessAddress}</small>}{receiptProfile.businessPhone && <small>{receiptProfile.businessPhone}</small>}{receiptProfile.businessEmail && <small>{receiptProfile.businessEmail}</small>}</div></div><div className="receipt-title"><h2>Sales receipt</h2><span className={`status-tag ${receipt.status === 'completed' ? 'status-active' : 'status-inactive'}`}>{receipt.status}</span></div><div className="receipt-meta"><span>Receipt<strong>{receipt.receiptNumber}</strong></span><span>Date &amp; time<strong>{new Date(receipt.createdAt).toLocaleString('en-GB', { timeZone: receiptProfile.timeZone })}</strong></span><span>Attendant<strong>{receipt.attendantName || userName}</strong></span><span>Payment method<strong>{paymentLabel[receipt.paymentMethod]}</strong></span></div><div className="receipt-items"><div className="receipt-item-heading"><span>Item / Qty x price</span><strong>Total</strong></div>{receipt.items.map((item, index) => <div key={`${item.productId}-${index}`}><span>{item.productName}<small>{item.quantity} {item.saleUnit} x {money(item.unitPrice)}{item.lineDiscount ? ` · Discount ${money(item.lineDiscount)}` : ''}</small></span><strong>{money(item.lineTotal)}</strong></div>)}</div><div className="receipt-totals"><div><span>Subtotal</span><strong>{money(receipt.subtotal)}</strong></div>{receipt.discountAmount > 0 && <div><span>Discount</span><strong>− {money(receipt.discountAmount)}</strong></div>}<div className="receipt-grand-total"><span>Total amount</span><strong>{money(receipt.totalAmount)}</strong></div><div><span>Amount paid</span><strong>{money(receipt.amountPaid)}</strong></div><div><span>Change</span><strong>{money(receipt.changeDue)}</strong></div></div>{receiptQr && <img className="receipt-qr" src={receiptQr} alt="Receipt QR code" />}<p className="receipt-thanks">{receiptProfile.receiptFooter}</p></article></section>}
    {reversal && <div className="finance-modal-backdrop"><section className="finance-dialog" role="dialog" aria-modal="true" aria-labelledby="reverse-title"><h2 id="reverse-title">Reverse sale</h2><p>Reversing {reversal.receiptNumber} restores the sold quantities to inventory. The original receipt remains in the audit history.</p><form onSubmit={(event) => void reverseSale(event)}><label>Reason for reversal<textarea name="reason" minLength={3} maxLength={500} required placeholder="Explain why this sale is being reversed" /></label><div className="finance-dialog-actions"><button type="button" className="button button-secondary" onClick={() => setReversal(null)}>Cancel</button><button className="button button-primary" disabled={busy}>Confirm reversal</button></div></form></section></div>}
    {correction && <div className="finance-modal-backdrop"><section className="finance-dialog" role="dialog" aria-modal="true" aria-labelledby="correction-title"><h2 id="correction-title">Correct {correction.type}</h2><p>Changes are saved with before-and-after values in the admin audit log.</p><form onSubmit={(event) => void correctTransaction(event)}><label>Category<select name="category" defaultValue={correction.category}>{categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Description<input name="description" required defaultValue={correction.description} /></label><div className="correction-row"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required defaultValue={correction.amount} /></label><label>Paid via<select name="paymentMethod" defaultValue={correction.paymentMethod}><option value="cash">Cash</option><option value="momo">MoMo</option><option value="other">Bank / other</option></select></label></div><label>Correction reason<textarea name="reason" minLength={3} maxLength={500} required placeholder="Why is this transaction being corrected?" /></label><div className="finance-dialog-actions"><button type="button" className="button button-secondary" onClick={() => setCorrection(null)}>Cancel</button><button className="button button-primary" disabled={busy}>Save correction</button></div></form></section></div>}
  </div>
}
function SalesTable({ sales, admin, onReceipt, onReverse }: { sales: Sale[]; admin: boolean; onReceipt: (sale: Sale) => void; onReverse: (sale: Sale) => void }) {
  if (!sales.length) return <div className="finance-empty">Completed receipts will appear here.</div>
  return <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>RECEIPT</th><th>ATTENDANT</th><th>PAYMENT</th><th>TOTAL</th><th>PROFIT</th><th>STATUS</th><th /></tr></thead><tbody>{sales.map((sale) => <tr key={sale.id}><td><strong>{sale.receiptNumber}</strong><small>{new Date(sale.createdAt).toLocaleString()}</small></td><td>{sale.attendantName || 'You'}</td><td>{paymentLabel[sale.paymentMethod]}</td><td><strong>{money(Number(sale.totalAmount))}</strong></td><td className="profit-value">{money(Number(sale.totalProfit))}</td><td><span className={`status-tag ${sale.status === 'completed' ? 'status-active' : 'status-inactive'}`}>{sale.status}</span></td><td className="table-actions"><button className="row-action" onClick={() => onReceipt(sale)}>Receipt</button>{admin && sale.status === 'completed' && <button className="row-action danger-action" onClick={() => onReverse(sale)}>Reverse</button>}</td></tr>)}</tbody></table></div>
}
function ReceiptTable({ receipts, onOpen }: { receipts: Array<{ id: number; receiptNumber: string; paymentMethod: Sale['paymentMethod']; totalAmount: number; status: Sale['status']; attendantName: string; createdAt: string }>; onOpen: (id: number) => void }) {
  if (!receipts.length) return <div className="finance-empty">No receipts match these filters.</div>
  return <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>RECEIPT</th><th>DATE &amp; TIME</th><th>ATTENDANT</th><th>PAYMENT</th><th>TOTAL</th><th>STATUS</th><th /></tr></thead><tbody>{receipts.map((item) => <tr key={item.id}><td><strong>{item.receiptNumber}</strong></td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.attendantName}</td><td>{paymentLabel[item.paymentMethod]}</td><td><strong>{money(Number(item.totalAmount))}</strong></td><td>{item.status}</td><td><button className="row-action" onClick={() => onOpen(item.id)}>Open / reprint</button></td></tr>)}</tbody></table></div>
}

function TransactionTable({ transactions, admin = false, userId, onReceipt, onReverse, onCorrect, onVoid }: { transactions: FinanceTransaction[]; admin?: boolean; userId: number; onReceipt?: (transaction: FinanceTransaction) => void; onReverse?: (transaction: FinanceTransaction) => void; onCorrect?: (transaction: FinanceTransaction) => void; onVoid?: (transaction: FinanceTransaction) => void }) {
  if (!transactions.length) return <div className="finance-empty">Transactions will appear here as the store operates.</div>
  return <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>TYPE / REFERENCE</th><th>RECORDED BY</th><th>PAYMENT</th><th>AMOUNT</th><th>STATUS</th><th>DATE</th>{admin && <th />}</tr></thead><tbody>{transactions.map((item) => <tr key={`${item.type}-${item.id}`}><td><strong>{item.type === 'sale' ? item.reference : item.category?.replaceAll('_', ' ')}</strong><small>{item.description || (item.type === 'sale' ? 'Product sale' : '')}</small></td><td>{item.attendantName || (item.userId === userId ? 'You' : 'Staff')}</td><td>{paymentLabel[item.paymentMethod] || item.paymentMethod}</td><td><strong className={item.type === 'expense' ? 'expense-value' : ''}>{item.type === 'expense' ? '− ' : ''}{money(Number(item.amount))}</strong></td><td>{item.voided ? 'Voided' : item.status || 'Recorded'}</td><td>{new Date(item.createdAt).toLocaleString()}</td>{admin && <td className="table-actions">{item.type === 'sale' ? <><button className="row-action" onClick={() => onReceipt?.(item)}>Receipt</button>{item.status === 'completed' && <button className="row-action danger-action" onClick={() => onReverse?.(item)}>Reverse</button>}</> : !item.voided && <><button className="row-action" onClick={() => onCorrect?.(item)}>Correct</button><button className="row-action danger-action" onClick={() => onVoid?.(item)}>Void</button></>}</td>}</tr>)}</tbody></table></div>
}
function ClosureTable({ closures }: { closures: Closure[] }) {
  if (!closures.length) return <div className="finance-empty">No cash closeouts recorded yet.</div>
  return <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>ATTENDANT / DATE</th><th>SALES</th><th>EXPENSES</th><th>EXPECTED</th><th>ACTUAL</th><th>DIFFERENCE</th></tr></thead><tbody>{closures.map((closure) => <tr key={closure.id}><td><strong>{closure.attendantName}</strong><small>{new Date(closure.businessDate).toLocaleDateString()}</small></td><td>{money(closure.totalSales)}</td><td>{money(closure.expenses)}</td><td>{money(closure.expectedCash)}</td><td>{money(closure.actualCash)}</td><td className={closure.difference < 0 ? 'expense-value' : closure.difference > 0 ? 'profit-value' : ''}>{closure.difference < 0 ? '− ' : closure.difference > 0 ? '+ ' : ''}{money(closure.difference)}</td></tr>)}</tbody></table></div>
}
