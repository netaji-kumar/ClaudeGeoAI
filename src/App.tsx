import React, { useState, useEffect, useRef, useCallback } from 'react';
import Header from './components/Header';
import Footer from './components/Footer';
import GeoBot from './components/ChatBot';
import ResultsTable from './components/ResultsTable';
import Map from './components/Map';
import HelpPage from './components/HelpPage';
import { Location, Message } from './types';
import { useTranslation } from 'react-i18next';
import { gisService } from './services/gisfunctions';
import { MessageSquare, Map as MapIcon, List } from 'lucide-react';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function App() {
  const [activeMobilePanel, setActiveMobilePanel] = useState<'chat' | 'map' | 'results'>('chat');
  const [selectedLocation, setSelectedLocation]   = useState<Location | null>(null);
  const [showHelp, setShowHelp]                   = useState(false);
  const [isFullscreenMap, setIsFullscreenMap]     = useState(false);
  const [isDarkMode, setIsDarkMode]               = useState(false);
  const [triggerSearch, setTriggerSearch]         = useState(false);
  const [locations, setLocations]                 = useState<Location[]>([]);
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([
    { text: t('chat.welcome'), isUser: false }
  ]);
  const [selectedMapLocation, setSelectedMapLocation] = useState<[number, number] | null>(null);
  const [clearMapMarker, setClearMapMarker]           = useState(false);
  const [polygonPoints, setPolygonPoints]             = useState<[number, number][] | null>(null);

  // Resizable panels
  const [leftWidth,  setLeftWidth]  = useState(50);
  const [chatHeight, setChatHeight] = useState(50);
  const draggingH    = useRef(false);
  const draggingV    = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftColRef   = useRef<HTMLDivElement>(null);
  const [isDesktop, setIsDesktop] = useState(typeof window !== 'undefined' && window.innerWidth >= 768);

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startDragH = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingH.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const startDragV = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingV.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingH.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setLeftWidth(clamp(((e.clientX - rect.left) / rect.width) * 100, 20, 80));
      }
      if (draggingV.current && leftColRef.current) {
        const rect = leftColRef.current.getBoundingClientRect();
        setChatHeight(clamp(((e.clientY - rect.top) / rect.height) * 100, 15, 85));
      }
    };
    const onUp = () => {
      if (draggingH.current || draggingV.current) {
        draggingH.current = draggingV.current = false;
        document.body.style.cursor = document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => { document.documentElement.classList.toggle('dark', isDarkMode); }, [isDarkMode]);
  useEffect(() => {
    if (messages.length === 1 && !messages[0].isUser)
      setMessages([{ text: t('chat.welcome'), isUser: false }]);
  }, [t]);

  const clearAllResults = () => {
    setLocations([]);
    setSelectedLocation(null);
    setSelectedMapLocation(null);
    setPolygonPoints(null);
    setClearMapMarker(true);
    gisService.clearGraphics();
  };

  const handleNewChat = () => {
    setMessages([{ text: t('chat.welcome'), isUser: false }]);
    clearAllResults();
  };

  const leftColStyle   = isDesktop ? { width: `${leftWidth}%`, flexShrink: 0 } : {};
  const chatPanelStyle = isDesktop ? { height: `${chatHeight}%`, flexShrink: 0 } : {};

  if (showHelp) {
    return (
      <div className="flex flex-col h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
        <Header
          onToggleHelp={() => setShowHelp(false)}
          isDarkMode={isDarkMode}
          toggleDarkMode={() => setIsDarkMode(v => !v)}
          showingHelp
        />
        <div className="flex-1 overflow-auto"><HelpPage /></div>
        <div className="hidden md:block"><Footer /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-gray-50 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800 text-gray-900 dark:text-gray-100">
      <Header
        onToggleHelp={() => setShowHelp(true)}
        isDarkMode={isDarkMode}
        toggleDarkMode={() => setIsDarkMode(v => !v)}
      />

      <div className="flex-1 flex overflow-hidden relative min-h-0">
        <div ref={containerRef} className="flex-1 flex flex-col md:flex-row overflow-hidden p-2 gap-2 md:gap-0 min-h-0">

          {/* Left column */}
          {!isFullscreenMap && (
            <div ref={leftColRef} style={leftColStyle}
              className={`flex flex-col overflow-hidden min-h-0 md:flex-none ${activeMobilePanel === 'map' ? 'hidden md:flex' : 'flex'}`}>

              {/* Chat panel */}
              <div style={chatPanelStyle}
                className={`overflow-hidden rounded-xl shadow-lg bg-gradient-to-br from-white via-white to-gray-50/80 dark:from-gray-800 dark:via-gray-800 dark:to-gray-900/80 border border-gray-200/80 dark:border-gray-700/80 backdrop-blur-sm md:flex-none ${activeMobilePanel === 'results' ? 'hidden md:block' : 'flex-1 md:flex-none'}`}>
                <GeoBot
                  onSearch={() => setTriggerSearch(true)}
                  messages={messages} setMessages={setMessages}
                  onClear={clearAllResults}
                  onLocationsUpdate={setLocations}
                  selectedMapLocation={selectedMapLocation}
                  onLocationSelect={setSelectedLocation}
                  onNewChat={handleNewChat}
                  polygonPoints={polygonPoints}
                />
              </div>

              {/* Vertical divider */}
              <div onMouseDown={startDragV} title="Drag to resize"
                className="hidden md:flex h-[8px] flex-shrink-0 items-center justify-center cursor-row-resize select-none rounded-sm transition-colors hover:bg-[rgb(28,96,154)]/10 group">
                <div className="flex gap-[4px] pointer-events-none">
                  {[0,1,2,3,4].map(i => (
                    <span key={i} className="w-[5px] h-[2px] rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-[rgb(28,96,154)] transition-colors" />
                  ))}
                </div>
              </div>

              {/* Results table */}
              <div className={`flex-1 overflow-hidden rounded-xl shadow-lg bg-gradient-to-br from-white via-white to-gray-50/80 dark:from-gray-800 dark:via-gray-800 dark:to-gray-900/80 border border-gray-200/80 dark:border-gray-700/80 backdrop-blur-sm ${activeMobilePanel === 'chat' ? 'hidden md:block' : 'flex-1 md:flex-1'}`}>
                <ResultsTable
                  onLocationSelect={setSelectedLocation}
                  triggerSearch={triggerSearch}
                  onSearchComplete={() => setTriggerSearch(false)}
                  locations={locations}
                />
              </div>
            </div>
          )}

          {/* Horizontal divider */}
          {!isFullscreenMap && (
            <div onMouseDown={startDragH} title="Drag to resize"
              className="hidden md:flex w-[8px] flex-shrink-0 items-center justify-center cursor-col-resize select-none rounded-sm transition-colors hover:bg-[rgb(28,96,154)]/10 group">
              <div className="flex flex-col gap-[4px] pointer-events-none">
                {[0,1,2,3,4].map(i => (
                  <span key={i} className="w-[2px] h-[5px] rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-[rgb(28,96,154)] transition-colors" />
                ))}
              </div>
            </div>
          )}

          {/* Map */}
          <div className={`flex-1 relative min-h-0 ${activeMobilePanel === 'map' || isFullscreenMap ? 'flex-1 min-h-0' : 'hidden md:block'}`}>
            <div className="absolute top-2 right-2 z-[1000]">
              <button onClick={() => setIsFullscreenMap(v => !v)}
                className="map-control-button"
                title={isFullscreenMap ? 'Exit fullscreen' : 'Fullscreen'}>
                {isFullscreenMap
                  ? <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
                  : <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zm11 0h7v7h-7zm0 11h7v7h-7zM3 14h7v7H3z"/></svg>}
              </button>
            </div>
            <div className={`map-container h-full ${isFullscreenMap ? 'fullscreen' : ''}`}>
              <Map
                selectedLocation={selectedLocation}
                locations={locations}
                isFullscreen={isFullscreenMap}
                isVisible={activeMobilePanel === 'map' || isFullscreenMap}
                onLocationClick={(c) => { setSelectedMapLocation(c); setPolygonPoints(null); setClearMapMarker(false); }}
                clearMarker={clearMapMarker}
                onClearGraphics={clearAllResults}
                key={`map-${isFullscreenMap}`}
                onPolygonComplete={(pts) => { setPolygonPoints(pts); setSelectedMapLocation(null); setClearMapMarker(false); }}
                onLocationSelect={setSelectedLocation}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="hidden md:block"><Footer /></div>

      {/* Mobile tab bar */}
      <div className="flex md:hidden border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        {([
          { id: 'chat',    icon: <MessageSquare size={20} />, label: 'Chat'    },
          { id: 'map',     icon: <MapIcon size={20} />,       label: 'Map'     },
          { id: 'results', icon: <List size={20} />,          label: 'Results' },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveMobilePanel(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-xs font-medium transition-colors relative
              ${activeMobilePanel === tab.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {tab.icon}<span>{tab.label}</span>
            {tab.id === 'results' && locations.length > 0 && (
              <span className="absolute top-1.5 right-[calc(50%-14px)] min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center">
                {locations.length > 999 ? '999+' : locations.length}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default App;
