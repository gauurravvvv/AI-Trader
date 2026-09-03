/**
 * Mock market events for the Live Market Events demo feed.
 * Replace loadMockMarketEvents() in MarketEventFeed.js with a real API call later.
 */
(function () {
    const MOCK_MARKET_EVENTS = [
        {
            id: 'event-1',
            symbol: 'NVDA',
            eventType: 'Earnings',
            headline: 'NVIDIA reports stronger data-center demand',
            source: 'Company Release',
            publishedAt: '2026-06-14T14:45:00Z'
        },
        {
            id: 'event-2',
            symbol: 'AAPL',
            eventType: 'Product',
            headline: 'Apple announces an upcoming developer event',
            source: 'Market News',
            publishedAt: '2026-06-14T14:34:00Z'
        },
        {
            id: 'event-3',
            symbol: 'MSFT',
            eventType: 'Regulation',
            headline: 'Microsoft responds to a regulatory review',
            source: 'Financial News',
            publishedAt: '2026-06-14T14:17:00Z'
        },
        {
            id: 'event-4',
            symbol: 'TSLA',
            eventType: 'Operations',
            headline: 'Tesla provides an update on vehicle deliveries',
            source: 'Company Update',
            publishedAt: '2026-06-14T13:55:00Z'
        },
        {
            id: 'event-5',
            symbol: 'GOOGL',
            eventType: 'Guidance',
            headline: 'Alphabet updates cloud revenue outlook for the quarter',
            source: 'Earnings Call',
            publishedAt: '2026-06-14T13:40:00Z'
        },
        {
            id: 'event-6',
            symbol: 'AMZN',
            eventType: 'Management',
            headline: 'Amazon names a new logistics operations lead',
            source: 'Company Release',
            publishedAt: '2026-06-14T13:22:00Z'
        },
        {
            id: 'event-7',
            symbol: 'META',
            eventType: 'M&A',
            headline: 'Meta confirms acquisition of an AI infrastructure startup',
            source: 'Market News',
            publishedAt: '2026-06-14T12:58:00Z'
        },
        {
            id: 'event-8',
            symbol: 'AAPL',
            eventType: 'Filing',
            headline: 'Apple files updated supplier disclosure with regulators',
            source: 'SEC Filing',
            publishedAt: '2026-06-14T12:35:00Z'
        },
        {
            id: 'event-9',
            symbol: 'JPM',
            eventType: 'Earnings',
            headline: 'JPMorgan posts higher net interest income in latest quarter',
            source: 'Company Release',
            publishedAt: '2026-06-14T12:10:00Z'
        },
        {
            id: 'event-10',
            symbol: 'BA',
            eventType: 'Operations',
            headline: 'Boeing updates production schedule for narrow-body jets',
            source: 'Industry Report',
            publishedAt: '2026-06-14T11:48:00Z'
        }
    ];

    function loadMockMarketEvents() {
        return MOCK_MARKET_EVENTS.map(function (event) {
            return Object.assign({}, event);
        });
    }

    window.MockMarketEvents = {
        MOCK_MARKET_EVENTS: MOCK_MARKET_EVENTS,
        loadMockMarketEvents: loadMockMarketEvents
    };
})();
