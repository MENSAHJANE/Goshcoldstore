import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type ChartProduct = {
  id: number
  name: string
  unit: string
  stock: number
  minimum: number
  status: 'Active' | 'Inactive'
}

export default function InventoryChart({ products }: { products: ChartProduct[] }) {
  const chartProducts = products.filter((product) => product.status === 'Active').slice(0, 5)
  return <div className="chart-container" role="img" aria-label="Stock quantity by product"><ResponsiveContainer width="100%" height={190}><BarChart data={chartProducts} layout="vertical" margin={{ top: 2, right: 15, bottom: 2, left: 0 }}><CartesianGrid stroke="#edf1ee" strokeDasharray="3 3" horizontal={false} /><XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#84918a' }} /><YAxis dataKey="name" type="category" width={118} axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#58665f' }} /><Tooltip formatter={(value, _name, item) => [`${value} ${item.payload.unit}`, 'Stock']} contentStyle={{ border: '1px solid #dfe7e1', borderRadius: 4, fontSize: 11 }} /><Bar dataKey="stock" barSize={13} radius={[0, 3, 3, 0]}>{chartProducts.map((product) => <Cell key={product.id} fill={product.stock <= product.minimum ? '#dfa04a' : '#60a17f'} />)}</Bar></BarChart></ResponsiveContainer></div>
}