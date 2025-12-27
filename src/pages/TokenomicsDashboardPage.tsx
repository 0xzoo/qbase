import React, { useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import './TokenomicsDashboardPage.css';

const TokenomicsDashboardPage: React.FC = () => {
  // --- State: Simulation Variables ---

  // User Metrics
  const [dau, setDau] = useState<number>(1000); // Daily Active Users

  // QP Mechanics (Costs & Grants)
  const [dailyGrantBase, setDailyGrantBase] = useState<number>(100);

  // Revenue Drivers (Inflows)
  const [mintingFeeEth, setMintingFeeEth] = useState<number>(0.003);
  const ethPrice = 3000; // USD
  const [mintsPerDay, setMintsPerDay] = useState<number>(10);

  const [tradingVolDaily, setTradingVolDaily] = useState<number>(10000); // USD
  const tradingFeePercent = 1; // %

  const [activeBounties, setActiveBounties] = useState<number>(5);
  const [avgBountyValue, setAvgBountyValue] = useState<number>(50); // USD

  const proSubs = 20;
  const subPrice = 10; // USD

  // Protocol Mechanics
  const [devTax, setDevTax] = useState<number>(20); // %
  const [qpPoolShare, setQpPoolShare] = useState<number>(80); // %

  // --- Calculations ---

  const simulation = useMemo(() => {
    // 1. Revenue Calculations (Monthly)
    const daysInMonth = 30;

    const monthlyMintRevenue = mintsPerDay * mintingFeeEth * ethPrice * daysInMonth;
    const monthlyTradingRevenue = tradingVolDaily * (tradingFeePercent / 100) * daysInMonth;
    const monthlyBountyRevenue = activeBounties * avgBountyValue * daysInMonth; // Assuming bounties refresh daily for simplicity or represent daily spend
    const monthlySubRevenue = proSubs * subPrice;

    const totalMonthlyRevenue = monthlyMintRevenue + monthlyTradingRevenue + monthlyBountyRevenue + monthlySubRevenue;

    // 2. Protocol Splits
    const devRevenue = totalMonthlyRevenue * (devTax / 100);
    const qpPoolValue = totalMonthlyRevenue * (qpPoolShare / 100);

    // 3. QP Economy (Monthly)
    // QP Issued = (DAU * Daily Grant) + (Tips/Boosts? No, tips are transfers usually, but let's assume some are sinks or extra generation if not 0-sum)
    // Actually, Daily Grant is the main source. Tips are transfers. 
    // Let's assume "Earned QP" that is claimable comes from the Grant that was spent by others.
    // Worst case / Max Claimable: All granted QP is spent and claimed.
    const totalQPIssued = dau * dailyGrantBase * daysInMonth;

    // Sinks (QP Removed from circulation before claim? Or just activity?)
    // In the "Pool" model, we divide Pool Value by Total Outstanding QP to get price.
    // Let's assume Total Outstanding QP = Total Issued (conservative).

    const valuePerQP = totalQPIssued > 0 ? qpPoolValue / totalQPIssued : 0;

    return {
      monthlyMintRevenue,
      monthlyTradingRevenue,
      monthlyBountyRevenue,
      monthlySubRevenue,
      totalMonthlyRevenue,
      devRevenue,
      qpPoolValue,
      totalQPIssued,
      valuePerQP
    };
  }, [
    dau, dailyGrantBase, mintsPerDay, mintingFeeEth, ethPrice,
    tradingVolDaily, tradingFeePercent, activeBounties, avgBountyValue,
    proSubs, subPrice, devTax, qpPoolShare
  ]);

  // --- Chart Data ---

  const revenueData = [
    { name: 'Minting', value: simulation.monthlyMintRevenue },
    { name: 'Trading Fees', value: simulation.monthlyTradingRevenue },
    { name: 'Bounties', value: simulation.monthlyBountyRevenue },
    { name: 'Subscriptions', value: simulation.monthlySubRevenue },
  ];

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

  const projectionData = [
    { name: 'Current', revenue: simulation.totalMonthlyRevenue, qpValue: simulation.valuePerQP * 1000 }, // value per 1k QP
    { name: '+10% Users', revenue: simulation.totalMonthlyRevenue * 1.1, qpValue: (simulation.qpPoolValue * 1.1) / (simulation.totalQPIssued * 1.1) * 1000 },
    { name: '10x Users', revenue: simulation.totalMonthlyRevenue * 10, qpValue: (simulation.qpPoolValue * 10) / (simulation.totalQPIssued * 10) * 1000 }, // Linear scaling assumption
  ];

  return (
    <div className="tokenomics-dashboard">
      <div className="dashboard-sidebar">
        <h2>Control Panel</h2>

        <div className="sidebar-section">
          <h3>User Metrics</h3>
          <div className="input-group">
            <label>DAU (Daily Active Users) <span>{dau.toLocaleString()}</span></label>
            <input type="range" min="100" max="100000" step="100" value={dau} onChange={(e) => setDau(Number(e.target.value))} />
          </div>
        </div>

        <div className="sidebar-section">
          <h3>Revenue Drivers</h3>
          <div className="input-group">
            <label>Daily Mints <span>{mintsPerDay}</span></label>
            <input type="range" min="0" max="1000" value={mintsPerDay} onChange={(e) => setMintsPerDay(Number(e.target.value))} />
          </div>
          <div className="input-group">
            <label>Mint Price (ETH) <span>{mintingFeeEth}</span></label>
            <input type="number" step="0.001" value={mintingFeeEth} onChange={(e) => setMintingFeeEth(Number(e.target.value))} />
          </div>
          <div className="input-group">
            <label>Daily Trading Vol ($) <span>{tradingVolDaily.toLocaleString()}</span></label>
            <input type="number" step="1000" value={tradingVolDaily} onChange={(e) => setTradingVolDaily(Number(e.target.value))} />
          </div>
          <div className="input-group">
            <label>Active Bounties <span>{activeBounties}</span></label>
            <input type="range" min="0" max="500" value={activeBounties} onChange={(e) => setActiveBounties(Number(e.target.value))} />
          </div>
          <div className="input-group">
            <label>Avg Bounty Value ($) <span>{avgBountyValue}</span></label>
            <input type="number" value={avgBountyValue} onChange={(e) => setAvgBountyValue(Number(e.target.value))} />
          </div>
        </div>

        <div className="sidebar-section">
          <h3>QP Mechanics</h3>
          <div className="input-group">
            <label>Daily Grant (QP) <span>{dailyGrantBase}</span></label>
            <input type="range" min="10" max="500" value={dailyGrantBase} onChange={(e) => setDailyGrantBase(Number(e.target.value))} />
          </div>
          <div className="input-group">
            <label>Protocol Tax (%) <span>{devTax}%</span></label>
            <input type="range" min="0" max="100" value={devTax} onChange={(e) => {
              setDevTax(Number(e.target.value));
              setQpPoolShare(100 - Number(e.target.value));
            }} />
          </div>
        </div>
      </div>

      <div className="dashboard-content">
        <h1>Tokenomics Simulator</h1>

        <div className="metrics-grid">
          <div className="metric-card">
            <h4>Monthly Revenue</h4>
            <span className="value">${simulation.totalMonthlyRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span className="subtext">Total Protocol Inflow</span>
          </div>
          <div className="metric-card">
            <h4>QP Pool Value</h4>
            <span className="value">${simulation.qpPoolValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span className="subtext">{qpPoolShare}% of Revenue</span>
          </div>
          <div className="metric-card">
            <h4>Dev Treasury</h4>
            <span className="value">${simulation.devRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span className="subtext">{devTax}% of Revenue</span>
          </div>
          <div className="metric-card">
            <h4>Value per 1k QP</h4>
            <span className="value">${(simulation.valuePerQP * 1000).toFixed(4)}</span>
            <span className="subtext">Based on {simulation.totalQPIssued.toLocaleString()} QP issued</span>
          </div>
        </div>

        <div className="charts-container">
          <div className="chart-card">
            <h3>Revenue Composition</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={revenueData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {revenueData.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => `$${value.toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-card">
            <h3>Growth Projections (Linear Scaling)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={projectionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis yAxisId="left" orientation="left" stroke="#8884d8" />
                <YAxis yAxisId="right" orientation="right" stroke="#82ca9d" />
                <Tooltip formatter={(value: number) => `$${value.toLocaleString()}`} />
                <Legend />
                <Bar yAxisId="left" dataKey="revenue" name="Monthly Revenue ($)" fill="#8884d8" />
                <Bar yAxisId="right" dataKey="qpValue" name="Value per 1k QP ($)" fill="#82ca9d" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TokenomicsDashboardPage;
