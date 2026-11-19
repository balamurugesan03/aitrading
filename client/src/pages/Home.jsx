import { Link } from 'react-router-dom';
import { Bot, CandlestickChart, Wallet, LayoutDashboard, ShieldCheck, UserCircle } from 'lucide-react';

// Home: only the important shortcuts, as big icons with plain words.
const TILES = [
  { to: '/bots', icon: Bot, color: '#8b5cf6', title: 'My Bots', text: 'Start / stop the robot that trades for you' },
  { to: '/terminal', icon: CandlestickChart, color: '#2fd59b', title: 'Buy / Sell', text: 'See the chart and trade yourself' },
  { to: '/history', icon: Wallet, color: '#d9b65c', title: 'Profit / Loss', text: 'How much you gained or lost' },
  { to: '/dashboard', icon: LayoutDashboard, color: '#3b82f6', title: 'Dashboard', text: 'Money, bots and trades in one place' },
  { to: '/risk', icon: ShieldCheck, color: '#22c55e', title: 'Safety', text: 'Limits that stop big losses' },
  { to: '/account', icon: UserCircle, color: '#f97316', title: 'Connect Binance', text: 'Exchange keys, password, alerts' },
];

export default function Home() {
  return (
    <div className="home-tiles">
      {TILES.map((t) => (
        <Link key={t.to} to={t.to} className="home-tile">
          <span className="home-tile-ico" style={{ background: `${t.color}22`, color: t.color }}><t.icon size={38} strokeWidth={1.8} /></span>
          <span className="home-tile-title">{t.title}</span>
          <span className="home-tile-text">{t.text}</span>
        </Link>
      ))}
    </div>
  );
}
