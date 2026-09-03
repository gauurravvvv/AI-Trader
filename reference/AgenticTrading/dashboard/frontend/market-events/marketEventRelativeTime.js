/**
 * Converts publishedAt ISO timestamps into compact relative labels.
 */
(function () {
    function formatMarketEventRelativeTime(publishedAt, now) {
        if (!publishedAt) {
            return '';
        }

        var reference = now instanceof Date ? now : new Date();
        var published = new Date(publishedAt);

        if (Number.isNaN(published.getTime())) {
            return '';
        }

        var diffMs = reference.getTime() - published.getTime();
        if (diffMs < 0) {
            return 'Now';
        }

        var diffSeconds = Math.floor(diffMs / 1000);
        if (diffSeconds < 45) {
            return 'Now';
        }

        var diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) {
            return diffMinutes + 'm';
        }

        var diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) {
            return diffHours + 'h';
        }

        var diffDays = Math.floor(diffHours / 24);
        return diffDays + 'd';
    }

    window.formatMarketEventRelativeTime = formatMarketEventRelativeTime;
})();
