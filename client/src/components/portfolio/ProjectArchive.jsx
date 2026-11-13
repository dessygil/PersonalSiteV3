import React from "react";
import archive from "../../data/github-projects.json";

export default function ProjectArchive() {
  return (
    <div className="project-archive-section">
      <details className="project-archive">
        <summary>
          <span>Explore {archive.projects.length} earlier GitHub projects</span>
          <span className="project-archive-toggle" aria-hidden="true">+</span>
        </summary>
        <div className="project-archive-content">
          <p className="project-archive-note">An archive of my 2022–2023 work, with original repository descriptions.</p>
          <ul className="project-archive-grid">
            {archive.projects.map(project => (
              <li key={project.name}>
                <article className="project-archive-card">
                  <p className="project-archive-meta">
                    {project.language && <span>{project.language}</span>}
                    <time dateTime={project.createdAt.slice(0, 10)}>{project.createdAt.slice(0, 4)}</time>
                  </p>
                  <h3><a href={project.url}>{project.name}</a></h3>
                  {project.description && <p className="project-archive-description">{project.description}</p>}
                  <div className="project-archive-links">
                    <a className="text-link" href={project.url} aria-label={`View ${project.name} on GitHub`}>View on GitHub <span aria-hidden="true">↗</span></a>
                    {project.homepage && <a className="text-link" href={project.homepage} aria-label={`Visit ${project.name}`}>Visit project <span aria-hidden="true">↗</span></a>}
                  </div>
                </article>
              </li>
            ))}
          </ul>
          <a className="text-link" href={archive.sourceUrl}>Browse all my repositories <span aria-hidden="true">↗</span></a>
        </div>
      </details>
    </div>
  );
}
