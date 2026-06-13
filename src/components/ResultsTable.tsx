import React, { useEffect, useState, useRef } from 'react';
import { Location } from '../types';
import { Search, FileSpreadsheet, File as FilePdf, AlertCircle, ChevronDown, ChevronUp, Download, X, TableProperties } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { gisService } from '../services/gisfunctions';

interface ResultsTableProps {
  onLocationSelect: (location: Location) => void;
  triggerSearch: boolean;
  onSearchComplete: () => void;
  locations: Location[];
}

const ResultsTable: React.FC<ResultsTableProps> = ({ 
  onLocationSelect, 
  triggerSearch, 
  onSearchComplete,
  locations
}) => {
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredLocations, setFilteredLocations] = useState<Location[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clear search and reset state when locations are cleared
  useEffect(() => {
    if (locations.length === 0) {
      setHasSearched(false);
      setSelectedLocationId(null);
      setSearchTerm('');
      setFilteredLocations([]);
      setIsCollapsed(true);
      gisService.clearGraphics();
    } else {
      setHasSearched(true);
      setFilteredLocations(locations);
      setIsCollapsed(false);
    }
  }, [locations]);

  // Handle search filtering
  useEffect(() => {
    if (!searchTerm.trim()) {
      setFilteredLocations(locations);
      return;
    }

    const searchTermLower = searchTerm.toLowerCase();
    const filtered = locations.filter(location => {
      return Object.entries(location).some(([key, value]) => {
        if (key === 'id' || key === 'coordinates' || key === 'geometryType') return false;
        return String(value).toLowerCase().includes(searchTermLower);
      });
    });
    setFilteredLocations(filtered);
  }, [searchTerm, locations]);

  const handleRowClick = (location: Location) => {
    if (!location || !location.coordinates) return;

    const isReselecting = selectedLocationId === location.id;
    
    setSelectedLocationId(isReselecting ? null : location.id);
    onLocationSelect(location);
    
    if (!isReselecting && location.coordinates && location.coordinates.length > 0) {
      // Delay ensures any in-progress zoomToFeatures animation has cleared
      // isZooming before this single-feature zoom fires (same pattern as ChatBot.tsx)
      setTimeout(() => gisService.zoomToFeature(location), 150);
    }
  };

  const getTableHeaders = () => {
    if (!locations || locations.length === 0) return [];
    const item = locations[0];
    return Object.keys(item).filter(key => !['id', 'coordinates', 'features'].includes(key));
  };

  const handleExportExcel = () => {
    if (filteredLocations.length === 0) return;

    const headers = getTableHeaders();
    let excelContent = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <style>
    table { border-collapse: collapse; width: 100%; }
    th { background-color: #1c609a; color: white; font-weight: bold; text-align: left; padding: 8px; border: 1px solid #ddd; }
    td { padding: 8px; border: 1px solid #ddd; text-align: left; mso-number-format:"\\@"; }
    tr:nth-child(even) { background-color: #f9f9f9; }
  </style>
</head>
<body>
  <table>
    <thead>
      <tr>${headers.map(header => `<th>${formatHeader(header)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${filteredLocations.map(item => `
        <tr>${headers.map(header => {
          const value = item[header] !== undefined && item[header] !== null ? String(item[header]) : '';
          return `<td>${value}</td>`;
        }).join('')}</tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>`;

    const blob = new Blob([excelContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'locations.xls';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPDF = () => {
    if (filteredLocations.length === 0) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      console.error('Failed to open print window');
      return;
    }

    const headers = getTableHeaders();
    const tableHTML = `
      <html>
        <head>
          <title>${t('results.title')}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; page-break-inside: auto; }
            tr { page-break-inside: avoid; page-break-after: auto; }
            th, td { padding: 8px; text-align: left; border: 1px solid #ddd; font-size: 12px; }
            th { background-color: #1c609a; color: white; font-weight: bold; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            h1 { color: #1c609a; font-size: 24px; margin-bottom: 10px; }
            .timestamp { color: #666; font-size: 12px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>${t('results.title')}</h1>
          <div class="timestamp">${t('common.generatedOn')}: ${new Date().toLocaleString()}</div>
          <table>
            <thead>
              <tr>${headers.map(h => `<th>${formatHeader(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${filteredLocations.map(item => `
                <tr>${headers.map(header => `<td>${item[header] || ''}</td>`).join('')}</tr>
              `).join('')}
            </tbody>
          </table>
        </body>
      </html>
    `;

    printWindow.document.write(tableHTML);
    printWindow.document.close();
    printWindow.print();
    setShowExportMenu(false);
  };

  const formatHeader = (header: string) => {
    return header
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const clearSearch = () => {
    setSearchTerm('');
    setFilteredLocations(locations);
  };

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center mb-4">
            <AlertCircle size={24} className="text-red-500 dark:text-red-400" />
          </div>
          <p className="text-gray-900 dark:text-gray-100 mb-2">{t('common.error')}</p>
          <p className="text-gray-600 dark:text-gray-400">{error}</p>
        </div>
      );
    }

    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-[rgb(28,96,154)] border-t-transparent mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">{t('results.loading')}</p>
        </div>
      );
    }

    if (!hasSearched) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
            <Search size={24} className="text-gray-400 dark:text-gray-500" />
          </div>
          <p className="text-gray-900 dark:text-gray-100 mb-2">{t('results.startSearch')}</p>
          <p className="text-gray-600 dark:text-gray-400">{t('results.searchHint')}</p>
        </div>
      );
    }

    if (locations.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
            <Search size={24} className="text-gray-400 dark:text-gray-500" />
          </div>
          <p className="text-gray-900 dark:text-gray-100 mb-2">{t('results.noResults')}</p>
          <p className="text-gray-600 dark:text-gray-400">{t('results.tryAgain')}</p>
        </div>
      );
    }

    const headers = getTableHeaders();

    return (
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse table-auto">
          <thead className="sticky top-0 bg-gradient-to-r from-[rgb(28,96,154)] via-[rgb(28,96,154)] to-[rgb(28,96,154)]">
            <tr>
              {headers.map((header) => (
                <th 
                  key={header}
                  className="px-3 py-1.5 text-left text-xs tracking-wider text-white"
                  style={{ minWidth: '100px' }}
                >
                  {formatHeader(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {filteredLocations.map((item) => (
              <tr 
                key={item.id}
                onClick={() => handleRowClick(item)}
                className={`table-row hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors ${
                  selectedLocationId === item.id ? 'bg-gray-100 dark:bg-gray-700' : ''
                }`}
              >
                {headers.map((header) => {
                  const value = item[header] !== undefined && item[header] !== null ? String(item[header]) : '';
                  return (
                    <td 
                      key={header} 
                      className="px-3 py-2 text-xs text-gray-900 dark:text-gray-100"
                      style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className={`dashboard-card flex flex-col transition-all duration-300 ${isCollapsed ? 'h-auto' : 'h-full'}`}>

      {/* ── Header bar ── */}
      <div className="px-4 py-1.5 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          {/* Left — icon + title + count badge */}
          <div
            className="flex items-center gap-2 cursor-pointer"
            onClick={() => locations.length > 0 && setIsCollapsed(v => !v)}
          >
            <div className="w-6 h-6 bg-[rgb(28,96,154)] bg-opacity-10 dark:bg-opacity-20 rounded-lg flex items-center justify-center">
              <TableProperties size={14} className="text-[rgb(28,96,154)]" />
            </div>
            <span className="text-base text-gray-800 dark:text-gray-100">
              {t('results.title')}
            </span>
            {locations.length > 0 && (
              <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full
                               text-[10px] font-bold bg-[rgb(28,96,154)] text-white leading-none">
                {loading ? '…' : filteredLocations.length}
              </span>
            )}
          </div>

          {/* Right — filter + export + toggle */}
          <div className="flex items-center gap-2">
            {locations.length > 0 && !isCollapsed && (
              <>
                {/* Filter input */}
                <div className="relative">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={t('results.filterPlaceholder')}
                    className="w-48 pl-3 pr-8 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                               border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none
                               focus:ring-2 focus:ring-[rgb(28,96,154)] focus:ring-opacity-50"
                  />
                  {searchTerm && (
                    <button onClick={clearSearch}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Export */}
                <div className="relative" ref={exportMenuRef}>
                  <button
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-gray-700 hover:text-[rgb(28,96,154)]
                               dark:text-gray-300 dark:hover:text-[rgb(28,96,154)] hover:bg-gray-100
                               dark:hover:bg-gray-700 rounded-lg transition-colors"
                    title={t('results.export')}
                  >
                    <Download size={16} />
                    <span className="text-sm">{t('results.export')}</span>
                    <ChevronDown size={14} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                  </button>
                  {showExportMenu && (
                    <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg
                                    border border-gray-200 dark:border-gray-700 py-1 z-10">
                      <button onClick={handleExportExcel}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700
                                   hover:text-[rgb(28,96,154)] dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <FileSpreadsheet size={16} /> {t('results.exportExcel')}
                      </button>
                      <button onClick={handleExportPDF}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700
                                   hover:text-[rgb(28,96,154)] dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <FilePdf size={16} /> {t('results.exportPDF')}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Collapse toggle */}
            {locations.length > 0 && (
              <button
                onClick={() => setIsCollapsed(v => !v)}
                className="p-1 text-gray-500 hover:text-[rgb(28,96,154)] hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
                title={isCollapsed ? 'Show results' : 'Hide results'}
              >
                {isCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Table body — only when expanded ── */}
      {!isCollapsed && (
        <div className="flex-1 overflow-hidden">
          {renderContent()}
        </div>
      )}
    </div>
  );
};

export default ResultsTable;