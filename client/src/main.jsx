import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';
import { AppProvider, useApp } from './lib/AppContext.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Terminal from './pages/Terminal.jsx';
import Options from './pages/Options.jsx';
import Scanner from './pages/Scanner.jsx';
import Bots from './pages/Bots.jsx';
import Backtest from './pages/Backtest.jsx';
import Assistant from './pages/Assistant.jsx';
import HistoryPage from './pages/History.jsx';
import SettingsPage from './pages/Settings.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Intel from './pages/Intel.jsx';
import Strategies from './pages/Strategies.jsx';
import Journal from './pages/Journal.jsx';
import Learning from './pages/Learning.jsx';
import Risk from './pages/Risk.jsx';
import Auth from './pages/Auth.jsx';
import Account from './pages/Account.jsx';
import Admin from './pages/Admin.jsx';
import Copy from './pages/Copy.jsx';
import Marketplace from './pages/Marketplace.jsx';
import ApiDocs from './pages/ApiDocs.jsx';
import SuperAdmin from './pages/SuperAdmin.jsx';

function Gate() {
  const { authed } = useApp();
  if (!authed) return <Auth />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/terminal" element={<Terminal />} />
        <Route path="/options" element={<Options />} />
        <Route path="/scanner" element={<Scanner />} />
        <Route path="/bots" element={<Bots />} />
        <Route path="/backtest" element={<Backtest />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/intel" element={<Intel />} />
        <Route path="/strategies" element={<Strategies />} />
        <Route path="/journal" element={<Journal />} />
        <Route path="/learning" element={<Learning />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/account" element={<Account />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/copy" element={<Copy />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/api-docs" element={<ApiDocs />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Super Admin: its own login and session, separate from the trading app */}
        <Route path="/superadmin/*" element={<SuperAdmin />} />
        <Route path="*" element={<AppProvider><Gate /></AppProvider>} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

// Installable mobile/desktop app (PWA). Only in production builds so dev hot-reload is not cached.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
