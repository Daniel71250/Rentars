'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface AnalyticsProps {
  data?: Array<{
    month: string;
    spent: number;
  }>;
}

export default function Analytics({ data }: AnalyticsProps) {
  const defaultData = [
    { month: 'Jan', spent: 400 },
    { month: 'Feb', spent: 300 },
    { month: 'Mar', spent: 600 },
    { month: 'Apr', spent: 800 },
    { month: 'May', spent: 500 },
    { month: 'Jun', spent: 700 },
  ];

  const chartData = data || defaultData;

  const totalSpent = chartData.reduce((sum, item) => sum + item.spent, 0);
  const chartDescription = `Bar chart of monthly USDC spending. ${chartData
    .map((item) => `${item.month}: ${item.spent} USDC`)
    .join(', ')}. Total: ${totalSpent} USDC.`;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 p-4 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Spending Analytics</h3>

      <div
        className="w-full overflow-hidden"
        role="img"
        aria-label={chartDescription}
      >
        <div className="w-full min-w-0" aria-hidden="true">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d1d5db" />
              <XAxis dataKey="month" tick={{ fill: '#374151' }} />
              <YAxis tick={{ fill: '#374151' }} width={48} />
              <Tooltip
                contentStyle={{ color: '#111827', backgroundColor: '#ffffff', border: '1px solid #d1d5db' }}
              />
              <Legend wrapperStyle={{ color: '#374151' }} />
              <Bar dataKey="spent" fill="#2563eb" name="USDC Spent" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="sr-only">
        <table>
          <caption>Monthly USDC spending summary</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">USDC Spent</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((item) => (
              <tr key={item.month}>
                <th scope="row">{item.month}</th>
                <td>{item.spent}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{totalSpent}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
</｜｜DSML｜｜ parameter>