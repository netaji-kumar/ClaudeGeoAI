import React from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();

  const toggleLanguage = () => {
    const newLang = i18n.language === 'ar' ? 'en' : 'ar';
    i18n.changeLanguage(newLang);
    document.documentElement.dir = newLang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = newLang;
  };

  return (
    <button
      onClick={toggleLanguage}
      className="flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
      title={i18n.language === 'ar' ? 'Switch to English' : 'التحويل إلى العربية'}
    >
      <Languages size={16} />
      <span className="text-sm font-medium hidden sm:inline">
        {i18n.language === 'ar' ? 'العربية' : 'English'}
      </span>
    </button>
  );
};

export default LanguageSwitcher;