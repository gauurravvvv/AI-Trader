/**
 * Renders a single compact market event card.
 */
(function () {
    var EVENT_TYPE_CLASS = {
        Earnings: 'event-type-earnings',
        Product: 'event-type-product',
        Regulation: 'event-type-regulation',
        Guidance: 'event-type-guidance',
        Management: 'event-type-management',
        'M&A': 'event-type-ma',
        Filing: 'event-type-filing',
        Operations: 'event-type-operations'
    };

    function createMarketEventCard(event, options) {
        var opts = options || {};
        var card = document.createElement('article');
        card.className = 'market-event-card';
        card.setAttribute('data-event-id', event.id);

        if (opts.animateIn) {
            card.classList.add('market-event-card--fade-in');
        }

        var topRow = document.createElement('div');
        topRow.className = 'market-event-card-top';

        var symbol = document.createElement('span');
        symbol.className = 'market-event-symbol';
        symbol.textContent = event.symbol;

        var badge = document.createElement('span');
        var badgeClass = EVENT_TYPE_CLASS[event.eventType] || 'event-type-default';
        badge.className = 'market-event-type-badge ' + badgeClass;
        badge.textContent = event.eventType.toUpperCase();

        var time = document.createElement('span');
        time.className = 'market-event-time';
        time.textContent = window.formatMarketEventRelativeTime(event.publishedAt, opts.now);

        topRow.appendChild(symbol);
        topRow.appendChild(badge);
        topRow.appendChild(time);

        var headline = document.createElement('p');
        headline.className = 'market-event-headline';
        headline.textContent = event.headline;

        card.appendChild(topRow);
        card.appendChild(headline);

        if (event.source) {
            var source = document.createElement('span');
            source.className = 'market-event-source';
            source.textContent = event.source;
            card.appendChild(source);
        }

        return card;
    }

    window.createMarketEventCard = createMarketEventCard;
})();
