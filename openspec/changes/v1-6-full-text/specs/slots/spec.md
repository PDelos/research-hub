## ADDED Requirements

### Requirement: Converter slot in the catalog
The slot catalog SHALL include the Converter slot (topic understanding) with the preset `converter-arxiv` (word F1 and
heading recall against arXiv HTML), and the weekly upgrade SHALL be able to focus on it when an alternative converter
is available, proposing a switch that beats the active converter by 0.02.

#### Scenario: Docling available
- **WHEN** the weekly upgrade focuses on the converter in the full image and Docling scores 0.81 against 0.62
- **THEN** switching to Docling is proposed with both numbers
