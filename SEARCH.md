# Search and article ownership

The hosted Site renders the profile, experience, projects, writing archive,
topic collections, and complete article text before JavaScript runs. Pages have
titles, descriptions, canonical links, sharing metadata, and structured data.
The sitemap is at `/sitemap.xml`; the RSS feed is at `/feed.xml`.

These features make public pages easier to discover and interpret. They do not
guarantee inclusion or ranking in search engines or AI answers. The initial
public launch used the Sites platform address. The owner has now connected
desmondgilmour.ca through Name.com while the .com transfer is pending.

## Canonical policy

On the temporary Sites address, article canonical links continue to identify
their original DEV.to URLs, avoiding a temporary ownership migration. When this
same application serves an article from
`https://desmondgilmour.ca`, that article identifies its own personal-site URL
as canonical instead. The source attribution still links to DEV.to.

The mapping for every existing and future imported article is:

    https://dev.to/dessygil/{slug}
    → https://desmondgilmour.ca/writing/{slug}

Public page requests to `www.desmondgilmour.ca` redirect permanently to the
matching apex .ca URL, preserving paths and query strings. API and sign-in
requests retain their original origin and authorization checks. The .com
domain can be made primary later after it is connected and verified.

Public launch on the Sites address was approved on November 13, 2026. The
DEV.to post settings remain unchanged. Once the personal
domain is connected and its article URLs return complete pages successfully,
the owner can authorize updating each DEV.to post's
canonical URL to its corresponding personal-site URL. That step requires the
owner's authenticated DEV.to access and must not point at the private preview.

Then verify the domain in Google Search Console and Bing Webmaster Tools and
submit its sitemap. Search ownership verification requires the owner's account
and sometimes DNS access. New posts should use their matching personal-site
canonical once their imported public pages are available.

No special AI discovery file is required. Keep the public pages readable,
accurate, crawlable, and linked from the owner's established profiles.
