import React, { useCallback, useEffect, useState } from 'react';
import { HelpCircle, Sun, Moon, Map, Zap, Server } from 'lucide-react';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from 'react-i18next';

const API_URL = import.meta.env.VITE_API_URL || '';

interface HeaderProps {
  onToggleHelp: () => void;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  showingHelp?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onToggleHelp, isDarkMode, toggleDarkMode, showingHelp }) => {
  const { t } = useTranslation();
  const [backendMode, setBackendMode] = useState<'API' | 'MCP'>('API');
  const [switching, setSwitching] = useState(false);

  // Fetch current mode on mount
  useEffect(() => {
    fetch(`${API_URL}/api/mode`)
      .then(r => r.json())
      .then(d => setBackendMode(d.mode === 'MCP' ? 'MCP' : 'API'))
      .catch(() => {/* server not running yet — default to API */});
  }, []);

  const toggleMode = useCallback(async () => {
    if (switching) return;
    const prev = backendMode;
    const next = backendMode === 'API' ? 'MCP' : 'API';
    // Optimistic update — makes button feel instant on mobile Safari/Chrome
    setBackendMode(next);
    setSwitching(true);
    try {
      const res = await fetch(`${API_URL}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (res.ok) {
        const data = await res.json();
        setBackendMode(data.mode === 'MCP' ? 'MCP' : 'API');
      } else {
        setBackendMode(prev); // revert on server error
      }
    } catch {
      setBackendMode(prev); // revert on network error
    } finally {
      setSwitching(false);
    }
  }, [backendMode, switching]);

  const isMcp = backendMode === 'MCP';

  return (
    <header className="bg-white shadow-md dark:bg-gray-800 text-gray-900 dark:text-white py-3 px-4 flex items-center justify-between z-[1001]">
      <div className="flex items-center space-x-2">
        <div className="w-8 h-8 bg-[rgb(28,96,154)] text-white p-1 rounded-lg flex items-center justify-center">
          <Map size={18} />
        </div>
        <h1 className="text-lg font-semibold">{t('app.title')}</h1>
      </div>

      <div className="flex items-center space-x-2">
        {/* API / MCP mode toggle
            touch-manipulation: removes 300ms tap delay on iOS Safari/Chrome
            min-h-[44px]: meets Apple/Google minimum touch target size          */}
        <button
          type="button"
          onClick={toggleMode}
          disabled={switching}
          title={isMcp ? 'Switch to direct API mode' : 'Switch to MCP server mode'}
          style={{ touchAction: 'manipulation' }}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-semibold
            border transition-all duration-200 select-none cursor-pointer
            ${switching ? 'opacity-50' : ''}
            ${isMcp
              ? 'bg-purple-100 border-purple-400 text-purple-700 dark:bg-purple-900/40 dark:border-purple-500 dark:text-purple-300'
              : 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-900/40 dark:border-blue-500 dark:text-blue-300'
            }
          `}
        >
          {isMcp
            ? <><Server size={13} /><span>MCP</span></>
            : <><Zap size={13} /><span>API</span></>
          }
        </button>

        <LanguageSwitcher />

        <button
          type="button"
          onClick={onToggleHelp}
          style={{ touchAction: 'manipulation' }}
          title={showingHelp ? 'Back to map' : 'Help'}
          className={`p-2 min-h-[44px] min-w-[44px] rounded-lg transition-colors ${showingHelp ? 'bg-[rgb(28,96,154)] text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
          <HelpCircle size={18} />
        </button>

        <button
          type="button"
          onClick={toggleDarkMode}
          style={{ touchAction: 'manipulation' }}
          title={isDarkMode ? 'Light mode' : 'Dark mode'}
          className="p-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors">
          {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
};

export default Header;
