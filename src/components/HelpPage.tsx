import React, { useState } from 'react';
import { Send, HelpCircle } from 'lucide-react';
import { api } from '../services/api';
import { useTranslation } from 'react-i18next';

const HelpPage: React.FC = () => {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const handleSubmit = async () => {
    if (name.trim() && query.trim() && !loading) {
      setLoading(true);
      setError(null);
      setSuccess(null);

      try {
        const response = await api.sendSupportEmail(name, query);
        setSuccess(true);
        setName('');
        setQuery('');
      } catch (error) {
        setSuccess(false);
        setError(error instanceof Error ? error.message : t('common.error'));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="flex-1 p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-3xl mx-auto">
        <div className="dashboard-card">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-[rgb(28,96,154)] bg-opacity-10 dark:bg-opacity-20 rounded-lg flex items-center justify-center mr-3">
                <HelpCircle size={20} className="text-[rgb(28,96,154)]" />
              </div>
              <h1 className="text-xl font-semibold text-gray-800 dark:text-white">{t('help.title')}</h1>
            </div>
          </div>
          <div className="p-6">
            <div className="space-y-6">
              {success && (
                <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-600 dark:text-green-400 text-sm">
                  {t('help.success')}
                </div>
              )}
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('help.name')}
                </label>
                <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('help.enterName')}
                  className="w-full p-2.5 border rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-[rgb(28,96,154)] focus:ring-opacity-50"
                />
              </div>
              <div>
                <label htmlFor="query" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('help.query')}
                </label>
                <textarea
                  id="query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('help.enterQuery')}
                  rows={6}
                  className="w-full p-2.5 border rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-[rgb(28,96,154)] focus:ring-opacity-50 resize-none"
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={loading || !name.trim() || !query.trim()}
                className={`${
                  loading || !name.trim() || !query.trim()
                    ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
                    : 'bg-[rgb(28,96,154)] hover:bg-[rgb(28,96,154)/90]'
                } text-white px-6 py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 w-full sm:w-auto`}
              >
                <Send size={18} />
                <span>{loading ? t('help.sending') : t('help.sendSupport')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HelpPage;