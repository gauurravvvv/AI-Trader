/**
 * Live Market Events feed — mock data with simulated refresh behavior.
 *
 * To connect a real API later, replace loadEvents() with an async fetch and
 * map the response into the same event shape used by createMarketEventCard().
 */
(function () {
    var MAX_VISIBLE_EVENTS = 3;
    var ROTATE_INTERVAL_MS = 30000;
    var CLOCK_INTERVAL_MS = 1000;
    var LOADING_DELAY_MS = 250;

    function MarketEventFeed(options) {
        this.container = options.container;
        this.getSelectedAssets = options.getSelectedAssets || function () { return []; };
        this.updatedAt = new Date();
        this.visibleEventIds = [];
        this.filteredEvents = [];
        this.status = 'loading';
        this.clockTimer = null;
        this.rotateTimer = null;
        this.updatedLabelEl = null;
        this.listEl = null;
        this.onUniverseChanged = this.handleUniverseChanged.bind(this);

        this.renderShell();
        this.bindEvents();
        this.start();
    }

    MarketEventFeed.prototype.renderShell = function () {
        this.container.innerHTML = '';
        this.container.classList.add('market-events-panel');

        var header = document.createElement('div');
        header.className = 'market-events-header';

        var titleRow = document.createElement('div');
        titleRow.className = 'market-events-title-row';

        var title = document.createElement('h3');
        title.className = 'section-title market-events-title';

        var liveWrap = document.createElement('span');
        liveWrap.className = 'market-events-live-wrap';

        var liveDot = document.createElement('span');
        liveDot.className = 'market-events-live-dot';
        liveDot.setAttribute('role', 'status');
        liveDot.setAttribute('aria-label', 'Live feed active');

        var liveLabel = document.createElement('span');
        liveLabel.className = 'market-events-live-label';
        liveLabel.textContent = 'LIVE';

        var titleSuffix = document.createElement('span');
        titleSuffix.textContent = ' MARKET EVENTS';

        liveWrap.appendChild(liveDot);
        liveWrap.appendChild(liveLabel);
        title.appendChild(liveWrap);
        title.appendChild(titleSuffix);
        titleRow.appendChild(title);

        this.updatedLabelEl = document.createElement('span');
        this.updatedLabelEl.className = 'market-events-updated';
        this.updatedLabelEl.setAttribute('aria-live', 'polite');
        titleRow.appendChild(this.updatedLabelEl);

        header.appendChild(titleRow);

        var disclaimer = document.createElement('p');
        disclaimer.className = 'market-events-disclaimer';
        disclaimer.textContent = 'Display only — not used by this backtest.';
        header.appendChild(disclaimer);

        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'market-events-body';

        this.listEl = document.createElement('div');
        this.listEl.className = 'market-events-list';
        this.listEl.setAttribute('role', 'feed');
        this.listEl.setAttribute('aria-label', 'Live market events');
        this.bodyEl.appendChild(this.listEl);

        var footerBtn = document.createElement('button');
        footerBtn.type = 'button';
        footerBtn.className = 'view-more-btn market-events-view-all';
        footerBtn.textContent = 'View All Events →';
        footerBtn.addEventListener('click', function () {
            console.log('View all market events (demo — no navigation configured).');
        });

        this.container.appendChild(header);
        this.container.appendChild(this.bodyEl);
        this.container.appendChild(footerBtn);
    };

    MarketEventFeed.prototype.bindEvents = function () {
        document.addEventListener('asset-universe-changed', this.onUniverseChanged);
    };

    MarketEventFeed.prototype.start = function () {
        var self = this;
        this.setStatus('loading');
        window.setTimeout(function () {
            self.loadEvents();
            self.setStatus(self.filteredEvents.length ? 'ready' : 'empty');
            self.renderEvents(false);
            self.updateUpdatedLabel();
        }, LOADING_DELAY_MS);

        this.clockTimer = window.setInterval(function () {
            self.updateUpdatedLabel();
            self.refreshRelativeTimes();
        }, CLOCK_INTERVAL_MS);

        this.rotateTimer = window.setInterval(function () {
            self.rotateTopEvent();
        }, ROTATE_INTERVAL_MS);
    };

    MarketEventFeed.prototype.loadEvents = function () {
        var allEvents = window.MockMarketEvents.loadMockMarketEvents();
        this.filteredEvents = this.filterByUniverse(allEvents);
        this.visibleEventIds = this.filteredEvents
            .slice(0, MAX_VISIBLE_EVENTS)
            .map(function (event) { return event.id; });
        this.updatedAt = new Date();
    };

    MarketEventFeed.prototype.filterByUniverse = function (events) {
        var assets = this.getSelectedAssets();
        if (!assets || !assets.length) {
            return events;
        }

        var assetSet = new Set(assets.map(function (symbol) {
            return symbol.toUpperCase();
        }));

        var filtered = events.filter(function (event) {
            return assetSet.has(event.symbol.toUpperCase());
        });

        if (filtered.length) {
            return filtered;
        }

        var builtinTab = document.getElementById('builtinTab');
        var isBuiltin = builtinTab && builtinTab.classList.contains('active');
        var djiaCard = document.getElementById('djiaCard');
        var isDjia = isBuiltin && djiaCard && djiaCard.classList.contains('selected');

        if (isDjia) {
            return events;
        }

        return [];
    };

    MarketEventFeed.prototype.handleUniverseChanged = function () {
        this.loadEvents();
        this.setStatus(this.filteredEvents.length ? 'ready' : 'empty');
        this.renderEvents(false);
        this.updateUpdatedLabel();
    };

    MarketEventFeed.prototype.getVisibleEvents = function () {
        var self = this;
        return this.visibleEventIds
            .map(function (id) {
                return self.filteredEvents.find(function (event) { return event.id === id; });
            })
            .filter(Boolean);
    };

    MarketEventFeed.prototype.rotateTopEvent = function () {
        if (this.status !== 'ready' || this.filteredEvents.length <= 1) {
            return;
        }

        var currentTopId = this.visibleEventIds[0];
        var candidates = this.filteredEvents.filter(function (event) {
            return event.id !== currentTopId;
        });

        if (!candidates.length) {
            return;
        }

        var nextEvent = candidates[Math.floor(Math.random() * candidates.length)];
        this.visibleEventIds = [nextEvent.id].concat(
            this.visibleEventIds.filter(function (id) { return id !== nextEvent.id; })
        ).slice(0, MAX_VISIBLE_EVENTS);

        this.updatedAt = new Date();
        this.renderEvents(true);
        this.updateUpdatedLabel();
    };

    MarketEventFeed.prototype.renderEvents = function (animateTop) {
        if (this.status === 'loading') {
            this.listEl.innerHTML = '<p class="market-events-state">Loading market events...</p>';
            return;
        }

        if (this.status === 'empty') {
            this.listEl.innerHTML = '<p class="market-events-state">No recent events for the selected assets.</p>';
            return;
        }

        var now = new Date();
        var visibleEvents = this.getVisibleEvents();
        this.listEl.innerHTML = '';

        visibleEvents.forEach(function (event, index) {
            var card = window.createMarketEventCard(event, {
                now: now,
                animateIn: animateTop && index === 0
            });
            this.listEl.appendChild(card);
        }, this);
    };

    MarketEventFeed.prototype.refreshRelativeTimes = function () {
        if (this.status !== 'ready') {
            return;
        }

        var now = new Date();
        var cards = this.listEl.querySelectorAll('.market-event-card');
        cards.forEach(function (card) {
            var eventId = card.getAttribute('data-event-id');
            var event = this.filteredEvents.find(function (item) { return item.id === eventId; });
            if (!event) {
                return;
            }

            var timeEl = card.querySelector('.market-event-time');
            if (timeEl) {
                timeEl.textContent = window.formatMarketEventRelativeTime(event.publishedAt, now);
            }
        }, this);
    };

    MarketEventFeed.prototype.updateUpdatedLabel = function () {
        if (!this.updatedLabelEl) {
            return;
        }

        var seconds = Math.max(0, Math.floor((Date.now() - this.updatedAt.getTime()) / 1000));
        this.updatedLabelEl.textContent = 'Updated ' + seconds + 's ago';
    };

    MarketEventFeed.prototype.setStatus = function (status) {
        this.status = status;
    };

    MarketEventFeed.prototype.destroy = function () {
        if (this.clockTimer) {
            window.clearInterval(this.clockTimer);
            this.clockTimer = null;
        }
        if (this.rotateTimer) {
            window.clearInterval(this.rotateTimer);
            this.rotateTimer = null;
        }
        document.removeEventListener('asset-universe-changed', this.onUniverseChanged);
    };

    window.MarketEventFeed = MarketEventFeed;
})();
